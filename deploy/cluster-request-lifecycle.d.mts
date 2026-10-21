export class ClusterUnavailableError extends Error{code:string;status:number;}
export function installClusterLifecycle(runtime?:NodeJS.Process,globals?:object):void;
export function clusterLifecycleReady(runtime?:NodeJS.Process,globals?:object):boolean;
export function trackClusterOperation<T>(operation:()=>Promise<T>,unavailable:()=>T|Promise<T>,runtime?:NodeJS.Process,globals?:object):Promise<T>;
export function trackClusterRequest(operation:()=>Promise<Response>,runtime?:NodeJS.Process,globals?:object):Promise<Response>;
