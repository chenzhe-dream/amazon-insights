import { WorkerTaskError } from "../runtime/retry-policy";

// Only the runtime's post-durability publication boundary may create this.
// Unknown storage/authority failures must never grant sibling model execution.
export class AlexaVocPublicationConflictError extends WorkerTaskError {
  constructor(cause: Error) {
    super("upstream-temporary", "Alexa VOC normalization publication conflicted after durable revision", { cause });
    this.name = "AlexaVocPublicationConflictError";
  }
}
