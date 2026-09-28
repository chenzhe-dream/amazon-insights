import { z } from 'zod';
import type { RemoteMcpConnector } from '../connectors/connector-contract';

export type MarketNodePathResolutionInput = Readonly<{
  marketplace: string;
  nodeId: string;
  month: string;
  organizationId: string;
  jobId: string;
  connector: RemoteMcpConnector;
  signal?: AbortSignal;
}>;

export class MarketNodePathResolutionError extends Error {
  constructor(readonly reason: 'source-mismatch' | 'empty' | 'scope-mismatch') {
    super(reason);
  }
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

/** Resolve a bare category node to the canonical provider path once per study. */
export async function resolveMarketNodePath(input: MarketNodePathResolutionInput): Promise<string> {
  if (input.connector.id !== 'sellerSprite') throw new MarketNodePathResolutionError('source-mismatch');
  const response = await input.connector.execute({
    operation: 'product_node',
    input: { request: { marketplace: input.marketplace, keyword: input.nodeId, ...(input.month==='last30'?{}:{month: input.month.replaceAll('-', '')}) } },
    signal: input.signal,
    governorScope: { organizationId: input.organizationId, jobId: input.jobId },
  });
  const body = object(response.data);
  if (body.code !== undefined && body.code !== 'OK') throw new MarketNodePathResolutionError('source-mismatch');
  const payload = body.data ?? response.data;
  const nodes = Array.isArray(payload) ? payload : [payload];
  const matches = nodes.map(object)
    .filter(row => /^\d+(?::\d+)*$/.test(String(row.nodeIdPath ?? '')))
    .filter(row => String(row.nodeIdPath).split(':').at(-1) === input.nodeId);
  const paths = new Set(matches.map(row => String(row.nodeIdPath)));
  if (!paths.size) throw new MarketNodePathResolutionError('empty');
  return z.string().regex(/^\d+(?::\d+)*$/).parse([...paths][0]);
}
