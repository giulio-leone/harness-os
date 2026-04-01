export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly entity: string,
    public readonly entityId: string,
    public readonly fromStatus: string,
    public readonly toStatus: string,
  ) {
    super(
      `Invalid state transition for ${entity} ${entityId} from ${fromStatus} to ${toStatus}`,
    );
    this.name = 'InvalidStateTransitionError';
  }
}

export const VALID_ISSUE_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  // newly planned
  pending: ['ready', 'needs_recovery'],
  // dependencies met
  ready: ['in_progress', 'blocked', 'pending', 'needs_recovery'],
  // actively worked on
  in_progress: ['done', 'failed', 'blocked', 'needs_recovery', 'pending', 'ready'],
  // dependencies not met or external block
  blocked: ['ready', 'pending', 'in_progress', 'needs_recovery'],
  // lease expired or runtime crash
  needs_recovery: ['in_progress', 'ready', 'pending'],
  // terminal success (can be rolled back)
  done: ['in_progress', 'pending'],
  // terminal failure (can be retried or rolled back)
  failed: ['in_progress', 'ready', 'pending'],
};

export const VALID_MILESTONE_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  pending: ['ready', 'blocked', 'in_progress', 'done'],
  ready: ['in_progress', 'blocked', 'pending', 'done'],
  in_progress: ['done', 'failed', 'blocked', 'pending'],
  blocked: ['ready', 'pending', 'in_progress'],
  done: ['in_progress', 'pending', 'blocked', 'ready'],
  failed: ['in_progress', 'ready', 'pending'],
};

export const VALID_LEASE_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  active: ['released', 'needs_recovery'],
  needs_recovery: ['recovered', 'active'],
  released: [], 
  recovered: [], 
};

export const VALID_RUN_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  reconciling: ['in_progress', 'needs_recovery', 'blocked', 'failed', 'done'],
  recovering: ['in_progress', 'needs_recovery', 'blocked', 'failed', 'done'],
  in_progress: ['done', 'failed', 'blocked', 'needs_recovery', 'pending', 'ready'],
  needs_recovery: ['in_progress', 'ready', 'pending', 'done', 'failed', 'blocked'],
  blocked: ['ready', 'pending', 'in_progress', 'done', 'failed', 'needs_recovery'],
  done: [],
  failed: [],
  finished: [],
};

export function assertValidTransition(
  entity: 'issue' | 'milestone' | 'lease' | 'run',
  entityId: string,
  fromStatus: string,
  toStatus: string,
): void {
  if (fromStatus === toStatus) {
    return;
  }

  let validNextStates: readonly string[] = [];

  switch (entity) {
    case 'issue':
      validNextStates = VALID_ISSUE_TRANSITIONS[fromStatus] ?? [];
      break;
    case 'milestone':
      validNextStates = VALID_MILESTONE_TRANSITIONS[fromStatus] ?? [];
      break;
    case 'lease':
      validNextStates = VALID_LEASE_TRANSITIONS[fromStatus] ?? [];
      break;
    case 'run':
      validNextStates = VALID_RUN_TRANSITIONS[fromStatus] ?? [];
      break;
  }

  if (!validNextStates.includes(toStatus)) {
    throw new InvalidStateTransitionError(entity, entityId, fromStatus, toStatus);
  }
}
