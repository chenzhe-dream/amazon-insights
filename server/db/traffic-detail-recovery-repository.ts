import type { DataSnapshotSubjectInput } from './data-snapshot-repository';
import type { TrafficListingCollection } from '../../shared/traffic-listing-contract';
import type { ListingRequestEvidence } from '../services/traffic-listing-collection';

export type TrafficDetailRecoveryRecord = { collection: TrafficListingCollection; requests: ListingRequestEvidence[]; baseSnapshotId: string; revision: number };
export interface TrafficDetailRecoveryRepository {
  append(input: DataSnapshotSubjectInput & { collection: TrafficListingCollection; requests: ListingRequestEvidence[]; baseSnapshotId: string; deadlineAt: string }): Promise<TrafficDetailRecoveryRecord>;
  findById(input: { organizationId: string; runId: string; id: string }): Promise<TrafficDetailRecoveryRecord | null>;
  latest(input: { organizationId: string; projectId: string; runId: string; marketplace: string; asins: readonly string[] }): Promise<TrafficDetailRecoveryRecord | null>;
}
