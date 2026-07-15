import { gql } from '@apollo/client';

export interface RoomTypeMapping {
  roomTypeId: string;
  externalRoomCode: string;
}

export interface RatePlanMapping {
  ratePlanId: string;
  externalRateCode: string;
}

export interface Channel {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
  roomTypeMappings: RoomTypeMapping[];
  ratePlanMappings: RatePlanMapping[];
}

export interface ChannelBooking {
  id: string;
  channelId: string;
  externalRef: string;
  status: 'RECEIVED' | 'CONFIRMED' | 'REJECTED' | 'DUPLICATE';
  reservationId: string | null;
  reason: string | null;
  createdAt: string;
}

export interface ChannelSyncRow {
  id: string;
  channelId: string;
  roomTypeId: string;
  fromDate: string;
  toDate: string;
  status: 'PENDING' | 'SENT' | 'FAILED';
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface SimulatedAri {
  externalRoomCode: string;
  externalRateCode: string | null;
  date: string;
  available: number;
  priceMinor: number | null;
}

/** Room types, so mappings read as names not ids. */
export interface RoomType {
  id: string;
  code: string;
  name: string;
}

const CHANNEL_FIELDS = `
  id
  code
  name
  enabled
  roomTypeMappings { roomTypeId externalRoomCode }
  ratePlanMappings { ratePlanId externalRateCode }
`;

export const CHANNELS_SETUP = gql`
  query ChannelsSetup {
    channels { ${CHANNEL_FIELDS} }
    roomTypes { id code name }
  }
`;

export const CHANNEL_BOOKINGS = gql`
  query ChannelBookings($channelId: ID) {
    channelBookings(channelId: $channelId) {
      id
      channelId
      externalRef
      status
      reservationId
      reason
      createdAt
    }
  }
`;

export const CHANNEL_SYNC_LOG = gql`
  query ChannelSyncLog($channelId: ID) {
    channelSyncLog(channelId: $channelId) {
      id
      channelId
      roomTypeId
      fromDate
      toDate
      status
      attempts
      lastError
      createdAt
      sentAt
    }
  }
`;

export const SIMULATED_ARI = gql`
  query SimulatedAri($channelId: ID!) {
    simulatedAri(channelId: $channelId) {
      externalRoomCode
      externalRateCode
      date
      available
      priceMinor
    }
  }
`;

export const SET_CHANNEL_ENABLED = gql`
  mutation SetChannelEnabled($input: SetChannelEnabledGqlInput!) {
    setChannelEnabled(input: $input) { ${CHANNEL_FIELDS} }
  }
`;

export const MAP_ROOM_TYPE = gql`
  mutation MapChannelRoomType($input: MapChannelRoomTypeGqlInput!) {
    mapChannelRoomType(input: $input) { ${CHANNEL_FIELDS} }
  }
`;

export const RESYNC_CHANNEL = gql`
  mutation ResyncChannel($input: ResyncChannelGqlInput!) {
    resyncChannel(input: $input) { queued }
  }
`;

export const SIMULATE_BOOKING = gql`
  mutation SimulateChannelBooking($input: SimulateChannelBookingGqlInput!) {
    simulateChannelBooking(input: $input) {
      outcome
      externalRef
      confirmationNo
      reason
    }
  }
`;
