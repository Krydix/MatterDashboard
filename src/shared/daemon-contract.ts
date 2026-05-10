import { AppConfig, MatterStatus } from "./types";

export type DaemonRequest =
  | { type: "ping" }
  | { type: "get-status" }
  | { type: "sync-config"; config: AppConfig }
  | { type: "reset" }
  | { type: "shutdown" };

export type DaemonResponse<T = unknown> = {
  ok: boolean;
  result?: T;
  error?: string;
};

export interface MatterWorkerCommandBase {
  requestId: number;
}

export type MatterWorkerCommand =
  | ({ type: "start"; storagePath: string; targets: AppConfig["targets"] } & MatterWorkerCommandBase)
  | ({ type: "sync-targets"; targets: AppConfig["targets"] } & MatterWorkerCommandBase)
  | ({ type: "get-status" } & MatterWorkerCommandBase)
  | ({ type: "reset" } & MatterWorkerCommandBase)
  | ({ type: "set-target-off"; targetId: string } & MatterWorkerCommandBase)
  | ({ type: "stop" } & MatterWorkerCommandBase);

export type MatterWorkerResponse = {
  type: "response";
  requestId: number;
  ok: boolean;
  result?: MatterStatus;
  error?: string;
};

export type MatterWorkerEvent = {
  type: "target-triggered" | "target-turned-off";
  targetId: string;
};