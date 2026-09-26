import {TrafficReportView} from "../project-report-views/traffic";
import type {TrafficSnapshotSources} from "./read-page-snapshot-traffic";

export function PageSnapshotTraffic(props:TrafficSnapshotSources) {
  return <TrafficReportView {...props}/>;
}
