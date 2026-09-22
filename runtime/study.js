// Continuous knowledge-point sessions. Ordinary self-assessments, retry
// appointments and FSRS cards remain different records.
const copy = x => JSON.parse(JSON.stringify(x));
export const continuous = catalog => catalog.learningPath?.experience === 'continuous-v1';
export const questionFor = (catalog,id) => catalog.exercises.find(q=>q.id===id)||catalog.practice.find(q=>q.id===id);
export function retryDelay(question) {
  return /证明/.test(question.questionHtml||'') ? 86400000 : 1800000;
}
export function scheduleRetry(state,catalog,attempt) {
  if(!state.study || attempt.mode==='review')return;
  const q=questionFor(catalog,attempt.questionId);
  if(!q||q.mode==='stage'||q.delayed)return;
  if(attempt.rating==='good'){delete state.study.retries[q.id];return;}
  state.study.retries[q.id]={sourceAttemptId:attempt.id,version:q.version,
    due:new Date(Date.parse(attempt.at)+retryDelay(q)).toISOString(),
    notBeforeBoundary:state.study.boundaryCount+3};
}
export function initializeStudy(state,catalog,now) {
  if(!continuous(catalog)||state.study)return false;
  const oldTask=copy(state.flow?.current||null);
  state.study={version:1,boundaryCount:Object.values(state.modules).filter(m=>m.completedAt).length,
    retries:{},block:null,presentation:null,legacyTask:oldTask,legacyReviewSession:copy(state.reviewSession)};
  if(oldTask?.kind==='exercise')state.study.resumeModule=questionFor(catalog,oldTask.questionId)?.moduleId||null;
  // Legacy confirmations and flags never enter this loop.
  const latest=new Map();
  for(const a of state.attempts)if(!a.undoneAt&&a.mode!=='review')latest.set(a.questionId,a);
  for(const a of latest.values())scheduleRetry(state,catalog,{...a,at:now});
  if(state.reviewSession){
    const s=state.reviewSession;
    const ids=s.ids.slice(s.index);
    if(ids.length)state.study.block={id:'continued-'+s.id,startedAt:now,afterModuleId:null,
      items:ids.map(id=>({id,kind:'review',version:catalog.reviews.find(q=>q.id===id)?.version||'missing',attemptId:null})),
      legacySessionId:s.id};
    state.reviewSession=null;
  }
  return true;
}
export function retryQueue(state,catalog,now) {
  if(!state.study)return [];
  return Object.entries(state.study.retries).filter(([id,r])=>{
    const q=questionFor(catalog,id);
    return q?.status==='usable' && q.version===r.version && state.modules[q.moduleId]?.completedAt
      && state.study.boundaryCount>=r.notBeforeBoundary && now>=r.due;
  }).sort((a,b)=>a[1].due.localeCompare(b[1].due)).map(([id])=>id);
}
export function queueBoundary(state,catalog,now,reviewIds,moduleId) {
  if(!state.study||state.study.block)return;
  const retry=retryQueue(state,catalog,now).slice(0,1);
  const reviews=state.counter.completedSincePrompt>=state.settings.reviewEvery
    ?reviewIds.slice(0,Math.min(2,state.settings.reviewLimit)):[];
  const items=[...retry.map(id=>({id,kind:'retry',version:questionFor(catalog,id).version,attemptId:null})),
    ...reviews.map(id=>({id,kind:'review',version:catalog.reviews.find(q=>q.id===id).version,attemptId:null}))];
  if(!items.length)return;
  state.study.block={id:'boundary-'+moduleId+'-'+state.study.boundaryCount,startedAt:now,afterModuleId:moduleId,items};
  state.counter.completedSincePrompt=0;
  // Reserve the retry at presentation, including when the learner skips it.
  for(const id of retry){const r=state.study.retries[id];r.notBeforeBoundary=state.study.boundaryCount+3;r.due=new Date(Date.parse(now)+retryDelay(questionFor(catalog,id))).toISOString();}
}
