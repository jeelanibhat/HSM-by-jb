import { gql } from '@apollo/client';

export const RUN_NIGHT_AUDIT = gql`
  mutation RunNightAudit {
    runNightAudit {
      runId
      businessDate
      newBusinessDate
      status
      steps { step status detail at }
    }
  }
`;

export const NIGHT_AUDIT_RUNS = gql`
  query NightAuditRuns {
    nightAuditRuns { id businessDate status completedAt }
  }
`;

export const DAILY_REVENUE = gql`
  query DailyRevenueReport($date: String!) {
    dailyRevenueReport(date: $date) {
      businessDate
      currency
      revenue { code count amountMinor }
      payments { code count amountMinor }
      adjustments { code count amountMinor }
      roomRevenueMinor
      otherRevenueMinor
      taxMinor
      grossRevenueMinor
      paymentsMinor
      adjustmentsMinor
      outstandingMinor
      openFolios
      snapshot {
        roomsAvailable roomsSold roomsOutOfOrder
        occupancyBps adrMinor revparMinor
      }
    }
  }
`;

export const OCCUPANCY = gql`
  query OccupancyReport($from: String!, $to: String!) {
    occupancyReport(from: $from, to: $to) {
      businessDate
      roomsAvailable
      roomsSold
      occupancyBps
      roomRevenueMinor
      adrMinor
      revparMinor
    }
  }
`;

export interface AuditStep {
  step: string;
  status: string;
  detail?: string | null;
  at: string;
}

export interface RevenueLine {
  code: string;
  count: number;
  amountMinor: number;
}

export interface Snapshot {
  roomsAvailable: number;
  roomsSold: number;
  roomsOutOfOrder: number;
  occupancyBps: number;
  adrMinor: number;
  revparMinor: number;
}

export interface DailyRevenue {
  businessDate: string;
  currency: string;
  revenue: RevenueLine[];
  payments: RevenueLine[];
  adjustments: RevenueLine[];
  roomRevenueMinor: number;
  otherRevenueMinor: number;
  taxMinor: number;
  grossRevenueMinor: number;
  paymentsMinor: number;
  adjustmentsMinor: number;
  outstandingMinor: number;
  openFolios: number;
  snapshot: Snapshot | null;
}
