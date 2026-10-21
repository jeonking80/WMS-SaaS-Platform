// Event bodies and IDs are unchanged; this version changes only source scheduling.
export const PROFILE_SCHEDULER_VERSION='independent-source-lanes-v2';
export const PROFILE_SOURCE_LANE_LIMIT=10;
export function assertSchedulerResume(config){if(config.scheduler_version!==PROFILE_SCHEDULER_VERSION)throw Error('Profile scheduler changed; resume with the original frozen client');}
export function createSourceScheduler({select,dispatch,onError=()=>{},laneLimit=PROFILE_SOURCE_LANE_LIMIT}){
 const activeIds=new Set(),lanes={new:new Set(),poll:new Set()},tasks=new Set();
 function pulse(lane){
  if(!lanes[lane])throw Error('Unknown source lane');
  const available=laneLimit-lanes[lane].size;if(available<=0)return;
  const selected=select(lane,available,[...activeIds]);
  for(const op of selected.slice(0,available)){
   if(activeIds.has(op.id))continue;
   activeIds.add(op.id);lanes[lane].add(op.id);
   const task=Promise.resolve().then(()=>dispatch(op)).catch(error=>onError(error)).finally(()=>{activeIds.delete(op.id);lanes[lane].delete(op.id);tasks.delete(task);});
   tasks.add(task);
  }
 }
 return {pulse,get activeCount(){return activeIds.size;},get activeIds(){return [...activeIds];},async settle(){return Promise.allSettled([...tasks]);}};
}
