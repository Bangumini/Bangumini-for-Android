import type { CollectionType } from "../../shared/api/types";

export const COLLECTION_TASK_EVENT = "bangumini:collection-task";
export const PENDING_COLLECTION_ACTIONS_EVENT = "bangumini:pending-collection-actions";

export type CollectionTaskStatus = "started" | "finished" | "failed";
export type PendingCollectionActionKind = "mark-watched";

export type CollectionTaskEventDetail = {
  taskId: number;
  status: CollectionTaskStatus;
  subjectId: number;
  previousType?: CollectionType;
  nextType?: CollectionType;
};

export type PendingCollectionAction = {
  id: string;
  kind: PendingCollectionActionKind;
  subjectId: number;
  subjectTitle: string;
  totalEp: number;
  previousType: CollectionType;
  nextType: CollectionType;
  createdAt: number;
};

type CollectionTaskListener = (detail: CollectionTaskEventDetail) => void;
type PendingActionsListener = (actions: PendingCollectionAction[]) => void;

let nextTaskId = 1;
let pendingActions: PendingCollectionAction[] = [];
const collectionTaskListeners = new Set<CollectionTaskListener>();
const pendingActionsListeners = new Set<PendingActionsListener>();

function emitCollectionTaskEvent(detail: CollectionTaskEventDetail) {
  collectionTaskListeners.forEach((listener) => listener(detail));
}

function emitPendingActionsChanged() {
  const snapshot = getPendingCollectionActions();
  pendingActionsListeners.forEach((listener) => listener(snapshot));
}

export function subscribeCollectionTasks(listener: CollectionTaskListener) {
  collectionTaskListeners.add(listener);
  return () => collectionTaskListeners.delete(listener);
}

export function subscribePendingCollectionActions(listener: PendingActionsListener) {
  pendingActionsListeners.add(listener);
  return () => pendingActionsListeners.delete(listener);
}

export function getPendingCollectionActions() {
  return [...pendingActions];
}

export function addPendingMarkWatchedAction(action: Omit<PendingCollectionAction, "id" | "kind" | "createdAt">) {
  const id = `mark-watched:${action.subjectId}`;
  const nextAction: PendingCollectionAction = {
    ...action,
    id,
    kind: "mark-watched",
    createdAt: Date.now(),
  };

  pendingActions = [
    nextAction,
    ...pendingActions.filter((item) => item.id !== id),
  ];
  emitPendingActionsChanged();
  return nextAction;
}

export function removePendingCollectionAction(id: string) {
  const next = pendingActions.filter((item) => item.id !== id);
  if (next.length === pendingActions.length) return;
  pendingActions = next;
  emitPendingActionsChanged();
}

export async function runCollectionTask(
  detail: Omit<CollectionTaskEventDetail, "taskId" | "status">,
  task: () => Promise<Omit<CollectionTaskEventDetail, "taskId" | "status"> | void>,
) {
  const taskId = nextTaskId++;
  emitCollectionTaskEvent({ ...detail, taskId, status: "started" });

  try {
    const result = await task();
    emitCollectionTaskEvent({
      ...detail,
      ...result,
      taskId,
      status: "finished",
    });
    return result;
  } catch (error) {
    emitCollectionTaskEvent({ ...detail, taskId, status: "failed" });
    throw error;
  }
}
