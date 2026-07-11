import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, ilike, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { TenantTransaction } from '../../../db/tenant-transaction';
import { PiiCipher } from '../../../shared/crypto/pii-cipher';
import { TransactionalUnitOfWork, type ActorContext } from '../../../shared';
import { reservationRooms, reservations } from '../../reservations/infra/schema';
import { guests } from '../infra/schema';

export interface GuestInput {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  idType?: string;
  idNumber?: string;
  address?: Record<string, unknown>;
  vip?: boolean;
}

/**
 * What leaves this service by default. Note what is NOT here: the ID number.
 * Only `idNumberMasked` (last four). The full value requires revealIdNumber(),
 * which writes an audit entry.
 */
export interface GuestView {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  idType: string | null;
  idNumberMasked: string | null;
  address: unknown;
  vip: boolean;
  blacklisted: boolean;
  anonymisedAt: Date | null;
}

@Injectable()
export class GuestsService {
  constructor(
    private readonly uow: TransactionalUnitOfWork,
    private readonly tx: TenantTransaction,
    private readonly pii: PiiCipher,
  ) {}

  private toView(row: typeof guests.$inferSelect): GuestView {
    // Destructure the secrets away rather than deleting them: a `delete` on an
    // object that later gains a field silently starts leaking it. This shape
    // breaks the build if someone adds a column and expects it here.
    const {
      idNumberEncrypted: _enc,
      idNumberHash: _hash,
      propertyId: _prop,
      createdAt: _c,
      updatedAt: _u,
      ...safe
    } = row;

    return safe as GuestView;
  }

  async create(actor: ActorContext, input: GuestInput): Promise<GuestView> {
    return this.uow.execute(actor, async (u) => {
      const id = uuidv7();

      const [created] = await u.tx
        .insert(guests)
        .values({
          id,
          propertyId: actor.propertyId,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email ?? null,
          phone: input.phone ?? null,
          idType: input.idType ?? null,
          ...this.encodeIdNumber(input.idNumber),
          address: (input.address ?? null) as never,
          vip: input.vip ?? false,
        })
        .returning();

      /**
       * The audit `after` deliberately records only that an ID was captured, not
       * what it was. An audit log that faithfully copies the passport number into
       * a second, append-only, never-encrypted table would defeat the entire
       * point of encrypting the first one.
       */
      u.audit({
        action: 'guest.created',
        entityType: 'guest',
        entityId: id,
        after: {
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          idType: input.idType,
          idCaptured: Boolean(input.idNumber),
        },
      });

      return this.toView(created!);
    });
  }

  async update(actor: ActorContext, id: string, input: Partial<GuestInput>): Promise<GuestView> {
    return this.uow.execute(actor, async (u) => {
      const [existing] = await u.tx.select().from(guests).where(eq(guests.id, id)).limit(1);
      if (!existing) throw new NotFoundException('Guest not found');

      if (existing.anonymisedAt) {
        throw new BadRequestException('This guest has been erased and cannot be edited.');
      }

      const [updated] = await u.tx
        .update(guests)
        .set({
          ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
          ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.idType !== undefined ? { idType: input.idType } : {}),
          ...(input.idNumber !== undefined ? this.encodeIdNumber(input.idNumber) : {}),
          ...(input.address !== undefined ? { address: input.address as never } : {}),
          ...(input.vip !== undefined ? { vip: input.vip } : {}),
          updatedAt: new Date(),
        })
        .where(eq(guests.id, id))
        .returning();

      u.audit({
        action: 'guest.updated',
        entityType: 'guest',
        entityId: id,
        before: { firstName: existing.firstName, lastName: existing.lastName },
        after: {
          firstName: updated!.firstName,
          lastName: updated!.lastName,
          idChanged: input.idNumber !== undefined,
        },
      });

      return this.toView(updated!);
    });
  }

  async findById(propertyId: string, id: string): Promise<GuestView | null> {
    return this.tx.run(propertyId, async (tx) => {
      const [row] = await tx.select().from(guests).where(eq(guests.id, id)).limit(1);
      return row ? this.toView(row) : null;
    });
  }

  /**
   * Free-text search over name / email / phone.
   *
   * The ID number is NOT searchable here — a substring search over an encrypted
   * column is impossible by construction, and that is a feature: it means nobody
   * can trawl the guest list by partial passport number. Exact lookup goes through
   * findByIdNumber(), which uses the blind index.
   */
  async search(propertyId: string, query: string): Promise<GuestView[]> {
    const q = query.trim();
    if (q.length < 2) return [];

    const term = `%${q}%`;

    return this.tx.run(propertyId, async (tx) => {
      const rows = await tx
        .select()
        .from(guests)
        .where(
          or(
            ilike(guests.firstName, term),
            ilike(guests.lastName, term),
            ilike(guests.email, term),
            ilike(guests.phone, term),
            // 'Priya Sharma' typed as one string should find her.
            sql`(${guests.firstName} || ' ' || ${guests.lastName}) ILIKE ${term}`,
          ),
        )
        .orderBy(desc(guests.vip), guests.lastName)
        .limit(25);

      return rows.map((r) => this.toView(r));
    });
  }

  /** Exact lookup by ID number, via the blind index. Never decrypts anything. */
  async findByIdNumber(propertyId: string, idNumber: string): Promise<GuestView | null> {
    const hash = this.pii.blindIndex(idNumber);

    return this.tx.run(propertyId, async (tx) => {
      const [row] = await tx
        .select()
        .from(guests)
        .where(eq(guests.idNumberHash, hash))
        .limit(1);

      return row ? this.toView(row) : null;
    });
  }

  /**
   * Reveal the full ID number.
   *
   * TDD §9: "audit-logged access for exports". This is the ONLY path to the
   * plaintext, and it always writes an audit row naming who looked and why —
   * BEFORE returning the value, and in the same transaction, so a read that
   * succeeds is a read that was recorded. A reveal that could fail to audit is a
   * reveal that will eventually go unrecorded.
   */
  async revealIdNumber(actor: ActorContext, guestId: string, reason: string): Promise<string> {
    return this.uow.execute(actor, async (u) => {
      const [row] = await u.tx.select().from(guests).where(eq(guests.id, guestId)).limit(1);
      if (!row) throw new NotFoundException('Guest not found');

      if (!row.idNumberEncrypted) {
        throw new NotFoundException('No ID number on file for this guest.');
      }

      u.audit({
        action: 'guest.id_number_revealed',
        entityType: 'guest',
        entityId: guestId,
        reason,
      });

      return this.pii.decrypt(row.idNumberEncrypted);
    });
  }

  /**
   * GDPR / DPDP erasure (TDD §9: "Data-retention job for GDPR/DPDP erasure requests").
   *
   * The ROW SURVIVES. Folios, invoices and the audit log all point at this guest,
   * and financial records must remain intact for years — a hard DELETE would either
   * cascade away accounting history or leave dangling references. So we destroy the
   * personal data and keep the skeleton: the books still balance, the person is gone.
   */
  async anonymise(actor: ActorContext, guestId: string, reason: string): Promise<GuestView> {
    return this.uow.execute(actor, async (u) => {
      const [row] = await u.tx
        .select()
        .from(guests)
        .where(eq(guests.id, guestId))
        .limit(1)
        .for('update');

      if (!row) throw new NotFoundException('Guest not found');
      if (row.anonymisedAt) return this.toView(row); // idempotent

      const [erased] = await u.tx
        .update(guests)
        .set({
          firstName: 'Erased',
          lastName: 'Guest',
          email: null,
          phone: null,
          idType: null,
          idNumberEncrypted: null,
          idNumberHash: null,
          idNumberMasked: null,
          address: null,
          anonymisedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(guests.id, guestId))
        .returning();

      // The audit entry records THAT an erasure happened and why — it must not
      // record what was erased, or the audit log becomes the leak.
      u.audit({
        action: 'guest.anonymised',
        entityType: 'guest',
        entityId: guestId,
        reason,
      });

      return this.toView(erased!);
    });
  }

  /** Stay history — the reason a returning guest gets recognised at the desk. */
  async stayHistory(propertyId: string, guestId: string) {
    return this.tx.run(propertyId, (tx) =>
      tx
        .select({
          reservationId: reservations.id,
          confirmationNo: reservations.confirmationNo,
          status: reservations.status,
          arrivalDate: reservations.arrivalDate,
          departureDate: reservations.departureDate,
          roomId: reservationRooms.roomId,
        })
        .from(reservations)
        .leftJoin(reservationRooms, eq(reservationRooms.reservationId, reservations.id))
        .where(eq(reservations.guestId, guestId))
        .orderBy(desc(reservations.arrivalDate))
        .limit(50),
    );
  }

  async setBlacklisted(actor: ActorContext, guestId: string, blacklisted: boolean, reason: string) {
    return this.uow.execute(actor, async (u) => {
      const [row] = await u.tx.select().from(guests).where(eq(guests.id, guestId)).limit(1);
      if (!row) throw new NotFoundException('Guest not found');

      const [updated] = await u.tx
        .update(guests)
        .set({ blacklisted, updatedAt: new Date() })
        .where(eq(guests.id, guestId))
        .returning();

      // Refusing service to a person is a serious act; it needs a name against it.
      u.audit({
        action: blacklisted ? 'guest.blacklisted' : 'guest.unblacklisted',
        entityType: 'guest',
        entityId: guestId,
        before: { blacklisted: row.blacklisted },
        after: { blacklisted },
        reason,
      });

      return this.toView(updated!);
    });
  }

  /** Encrypt + index + mask, or clear all three. Kept together so they cannot drift. */
  private encodeIdNumber(idNumber: string | undefined) {
    if (idNumber === undefined) return {};

    const trimmed = idNumber.trim();
    if (trimmed === '') {
      return { idNumberEncrypted: null, idNumberHash: null, idNumberMasked: null };
    }

    return {
      idNumberEncrypted: this.pii.encrypt(trimmed),
      idNumberHash: this.pii.blindIndex(trimmed),
      idNumberMasked: this.pii.mask(trimmed),
    };
  }
}

/** Exported for the reservations module, which creates guests inline at booking. */
export type { GuestView as Guest };
