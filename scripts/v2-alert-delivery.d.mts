import type { DatabaseSync } from 'node:sqlite';
import type { MonitorAlert,MonitorReport } from './v2-monitor-lib.mjs';
export type WebhookConfiguration={url:string;token?:string;receiverId:string;timeoutMs:number};
export function webhookConfiguration(env?:Record<string,string|undefined>):WebhookConfiguration|null;
export function openAlertOutbox(file:string|undefined):Promise<DatabaseSync>;
export function safeAlertEnvelope(alert:MonitorAlert):Record<string,unknown>;
export function enqueueAlertReport(db:DatabaseSync,report:MonitorReport,configuration:WebhookConfiguration,options?:{now?:number;resolveMissing?:boolean}):{enqueued:number};
export function cachedFailureReport(db:DatabaseSync,configuration:WebhookConfiguration,tenantId:string,warehouseIds:string[],options?:{now?:number}):MonitorReport|null;
export function deliverAlerts(db:DatabaseSync,configuration:WebhookConfiguration,options?:{now?:number;fetchImpl?:typeof fetch;max?:number;requeueFailed?:boolean}):Promise<{delivery:string;sent:number;retained_for_retry:number;retried:number;failed:number;failed_this_run:number;receiver_confirmation:string}>;
