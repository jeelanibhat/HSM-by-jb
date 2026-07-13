import { gql } from '@apollo/client';

export type HousekeepingTaskStatus = 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'INSPECTED';
export type HousekeepingTaskType = 'DEPARTURE' | 'STAYOVER' | 'DEEP_CLEAN' | 'TURNDOWN';

export interface HousekeepingTask {
  id: string;
  roomId: string;
  roomNumber: string;
  roomFloor: string | null;
  roomTypeCode: string;
  roomStatus: string;
  businessDate: string;
  type: HousekeepingTaskType;
  status: HousekeepingTaskStatus;
  assignedTo: string | null;
  assigneeName: string | null;
  credits: number;
  notes: string | null;
  inspectionNote: string | null;
  failedInspections: number;
}

export interface Attendant {
  id: string;
  name: string;
}

export const HOUSEKEEPING_BOARD = gql`
  query HousekeepingBoard($date: String) {
    housekeepingBoard(date: $date) {
      id
      roomId
      roomNumber
      roomFloor
      roomTypeCode
      roomStatus
      businessDate
      type
      status
      assignedTo
      assigneeName
      credits
      notes
      inspectionNote
      failedInspections
    }
  }
`;

export const ATTENDANTS = gql`
  query HousekeepingAttendants {
    housekeepingAttendants {
      id
      name
    }
  }
`;

export const GENERATE_BOARD = gql`
  mutation GenerateHousekeepingBoard($input: GenerateHousekeepingBoardGqlInput) {
    generateHousekeepingBoard(input: $input) {
      created
      businessDate
    }
  }
`;

export const ASSIGN_TASK = gql`
  mutation AssignHousekeepingTask($input: AssignHousekeepingTaskGqlInput!) {
    assignHousekeepingTask(input: $input) {
      id
      assignedTo
      assigneeName
    }
  }
`;

export const START_TASK = gql`
  mutation StartHousekeepingTask($input: StartHousekeepingTaskGqlInput!) {
    startHousekeepingTask(input: $input) {
      id
      status
      assignedTo
    }
  }
`;

export const COMPLETE_TASK = gql`
  mutation CompleteHousekeepingTask($input: CompleteHousekeepingTaskGqlInput!) {
    completeHousekeepingTask(input: $input) {
      id
      status
    }
  }
`;

export const INSPECT_TASK = gql`
  mutation InspectHousekeepingTask($input: InspectHousekeepingTaskGqlInput!) {
    inspectHousekeepingTask(input: $input) {
      id
      status
      failedInspections
      inspectionNote
    }
  }
`;
