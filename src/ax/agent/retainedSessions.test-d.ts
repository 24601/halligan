import {
  type AxAgentSessionClient,
  type AxAgentSessionHandle,
  AxAgentSessionHost,
  type AxAgentSessionRegistration,
  type AxAgentSessionRegistrySnapshot,
  type AxAgentSessionSendReceipt,
  type AxAgentSessionStatusView,
  type AxRetainedAgent,
} from '../index.js';

type ChildInput = { task: string };
type ChildOutput = { answer: string };

{
  const retainedAgent = {} as AxRetainedAgent<ChildInput, ChildOutput>;
  const registration = {
    key: 'researcher.v1',
    create: (context) => {
      const _session: AxAgentSessionClient = context.session;
      const _depth: number = context.depth;
      return retainedAgent;
    },
    authorizedChildren: ['leaf.v1'],
  } satisfies AxAgentSessionRegistration<ChildInput, ChildOutput>;

  const host = new AxAgentSessionHost({
    registrations: [
      registration,
      { key: 'leaf.v1', create: () => retainedAgent },
    ],
    limits: { maxChildren: 4, maxConcurrency: 2 },
  });
  const root: Promise<AxAgentSessionClient> = host.createRoot({
    authorizedChildren: ['researcher.v1'],
  });
  const snapshot = {} as AxAgentSessionRegistrySnapshot;
  const restored: Promise<AxAgentSessionClient> = host.restore(snapshot, {
    expectedPolicyDigest: snapshot.policyDigest,
  });
  void root;
  void restored;
}

{
  const client = {} as AxAgentSessionClient;
  const handle = {} as AxAgentSessionHandle;
  const epoch: number = handle.epoch;

  const spawned: Promise<AxAgentSessionHandle> = client.spawn('researcher.v1', {
    task: 'inspect',
  });
  const inspected: Promise<AxAgentSessionStatusView> = client.inspect(handle);
  const receipt: Promise<AxAgentSessionSendReceipt> = client.send(
    handle,
    { task: 'continue' },
    'follow-up'
  );
  const cancelled: Promise<void> = client.cancel(handle);
  const disposed: Promise<void> = client.dispose(handle);
  void spawned;
  void inspected;
  void receipt;
  void cancelled;
  void disposed;
  void epoch;

  // @ts-expect-error delivery mode must be explicit and supported
  client.send(handle, { task: 'continue' }, 'interrupt');
}

// @ts-expect-error limits are numeric
new AxAgentSessionHost({ registrations: [], limits: { maxDepth: '2' } });
