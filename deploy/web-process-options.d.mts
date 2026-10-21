export function workerCount(environment?:Record<string,string|undefined>):number;
export function poolMaximum(environment?:Record<string,string|undefined>):number;
export function poolPartition(count:number):number[];
export function workerEnvironment(environment:Record<string,string|undefined>,slot:number,poolMax:number):Record<string,string|undefined>;
