import { BadRequestException, Injectable } from '@nestjs/common';
import {
  add,
  businessDate,
  eachDateInStay,
  money,
  nightsBetween,
  taxFromBps,
  zero,
  type Money,
} from '@hotelos/domain';
import { and, eq, gte, lt } from 'drizzle-orm';
import { TenantTransaction } from '../../../db/tenant-transaction';
import { ratePrices } from '../../inventory/infra/schema';
import { properties, taxes } from '../../property/infra/schema';

export interface QuoteNight {
  date: string;
  priceMinor: number;
}

export interface Quote {
  nights: number;
  currency: string;
  nightly: QuoteNight[];
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  /** Nights with no rate loaded. A quote with holes in it is not a quote. */
  unpricedDates: string[];
}

/**
 * Price a stay BEFORE it is booked.
 *
 * This exists so the browser never does money arithmetic. A client that summed the
 * nightly rates and estimated the GST would eventually disagree with the folio —
 * the quote says one thing at the desk, the bill says another at check-out, and the
 * guest is right to be angry. Same code path, same rounding, same tax config as the
 * folio uses.
 */
@Injectable()
export class QuoteService {
  constructor(private readonly tx: TenantTransaction) {}

  async quote(
    propertyId: string,
    roomTypeId: string,
    ratePlanId: string,
    arrival: string,
    departure: string,
  ): Promise<Quote> {
    const from = businessDate(arrival);
    const to = businessDate(departure);

    // Throws on a zero-night or reversed stay, with a sentence a human wrote.
    const nights = nightsBetween(from, to);

    return this.tx.run(propertyId, async (tx) => {
      const [property] = await tx
        .select()
        .from(properties)
        .where(eq(properties.id, propertyId))
        .limit(1);

      if (!property) throw new BadRequestException('Property not found');
      const currency = property.currency;

      const prices = await tx
        .select()
        .from(ratePrices)
        .where(
          and(
            eq(ratePrices.ratePlanId, ratePlanId),
            eq(ratePrices.roomTypeId, roomTypeId),
            gte(ratePrices.date, from),
            // Half-open: the departure night is never charged.
            lt(ratePrices.date, to),
          ),
        );

      const byDate = new Map(prices.map((p) => [p.date, p.priceMinor]));

      const nightly: QuoteNight[] = [];
      const unpriced: string[] = [];
      let subtotal = zero(currency);

      for (const date of eachDateInStay(from, to)) {
        const price = byDate.get(date);

        if (price === undefined) {
          // Do not invent a rate and do not quietly quote zero. Say which nights
          // are unpriced and let the desk decide.
          unpriced.push(date);
          continue;
        }

        nightly.push({ date, priceMinor: price });
        subtotal = add(subtotal, money(price, currency));
      }

      const taxRows = await tx.select().from(taxes).where(eq(taxes.propertyId, propertyId));

      let tax = zero(currency);
      let total: Money = subtotal;

      for (const t of taxRows) {
        const mode = t.type === 'INCLUSIVE' ? 'INCLUSIVE' : 'EXCLUSIVE';
        const amount = taxFromBps(subtotal, t.rateBps, mode);

        tax = add(tax, amount);

        // EXCLUSIVE tax sits on top of the rate; INCLUSIVE is already inside it, so
        // the total does not move. Getting this backwards quotes the guest a number
        // 12% too high or 12% too low.
        if (mode === 'EXCLUSIVE') total = add(total, amount);
      }

      return {
        nights,
        currency,
        nightly,
        subtotalMinor: subtotal.minor,
        taxMinor: tax.minor,
        totalMinor: total.minor,
        unpricedDates: unpriced,
      };
    });
  }
}
