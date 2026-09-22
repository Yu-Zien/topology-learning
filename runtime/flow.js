// A deterministic route over explicit section plans. Personal confirmations
// never come from production status, scroll position, or an FSRS rating.
const copy = x => JSON.parse(JSON.stringify(x));
import { continuous } from './study.js';
export const sectionPlans = catalog => catalog.learningPath?.sections || [];
export const moduleItem = (catalog,id) => catalog.modules.find(m=>m.id===id);
export const practiceItem = (catalog,id) => catalog.exercises.find(q=>q.id===id) || catalog.practice.find(q=>q.id===id);
export const confirmed = (state,id) => !!state.flow?.confirmations[id];
export function moduleQuestions(catalog,moduleId) {
  return moduleItem(catalog,moduleId)?.practice || [];
}
const deferred = (state,id,version) => state.flow?.deferred[id]?.version === version;

export function nextTask(state,catalog) {
  const sections=sectionPlans(catalog);
  if(continuous(catalog)&&state.study?.resumeModule){
    const section=sections.find(s=>s.moduleIds.includes(state.study.resumeModule));
    if(section)return {kind:'module',id:state.study.resumeModule,moduleId:state.study.resumeModule,sectionId:section.id};
  }
  for(const section of sections) {
    for(const id of section.moduleIds) {
      const m=moduleItem(catalog,id);
      if(state.modules[id]?.completedAt)continue; // Preserve prior explicit module completion.
      if(!m||m.status!=='usable') {
        if(deferred(state,id,m?.version||'missing'))continue;
        return {kind:'blocked',id,sectionId:section.id,moduleId:id,version:m?.version||'missing'};
      }
      return {kind:'module',id,sectionId:section.id,moduleId:id};
    }
    for(const id of section.requiredExercises) {
      const q=practiceItem(catalog,id);
      // Originals already live in their corresponding knowledge-point body.
      // Ending that knowledge point never invents a per-question assessment.
      if(continuous(catalog)&&section.moduleIds.includes(q?.moduleId))continue;
      if(confirmed(state,id))continue;
      if(q?.status==='usable')return {kind:'exercise',id,sectionId:section.id,questionId:id};
      if(!deferred(state,id,q?.version||'missing'))return {kind:'blocked',id,sectionId:section.id,questionId:id,version:q?.version||'missing'};
    }
    for(const gap of section.gaps||[]) {
      if(!deferred(state,gap.id,gap.version))return {kind:'blocked',id:gap.id,sectionId:section.id,gapId:gap.id,version:gap.version};
    }
    if(state.flow?.sections[section.id]?.planVersion!==catalog.learningPath.version)
      return {kind:'closing',id:section.id+'-close',sectionId:section.id};
  }
  const last=sections.at(-1);
  return last?{kind:'boundary',id:last.nextSection?.id||last.id+'-end',sectionId:last.id}:null;
}

export function initializeFlow(state,catalog) {
  if(!sectionPlans(catalog).length)return false;
  const added=!state.flow;
  state.flow ||= {version:1,legacyPosition:copy(state.newCourse),confirmations:{},deferred:{},sections:{},current:null};
  refreshFlow(state,catalog,added?state.flow.legacyPosition:null);
  return added;
}
export function refreshFlow(state,catalog,legacy=null) {
  if(!state.flow)return;
  const task=nextTask(state,catalog),prior=state.flow.current;
  const anchor=task?.id===prior?.id?prior?.anchor||'':task?.moduleId===legacy?.moduleId?legacy?.anchor||'':'';
  state.flow.current=task?{...task,anchor}:null;
  state.newCourse=task?.kind==='module'?{moduleId:task.moduleId,anchor}:null;
}
export function currentTask(state,catalog) {
  const task=nextTask(state,catalog);
  return task?{...task,anchor:state.flow?.current?.id===task.id?state.flow.current.anchor||'':''}:null;
}
export function canBrowse(state,catalog,moduleId) {
  const m=moduleItem(catalog,moduleId);
  if(!m)return false;
  if(state.modules[moduleId]?.completedAt||state.modules[moduleId]?.startedAt)return true;
  const task=currentTask(state,catalog),section=sectionPlans(catalog).find(s=>s.id===task?.sectionId);
  if(!section)return false;
  if(section.optionalChecks?.includes(moduleId))return !!state.modules[section.exerciseStartModule]?.startedAt||!!state.modules['T01-01-M020']?.completedAt;
  if(!section.moduleIds.includes(moduleId))return false;
  if(!task.moduleId)return true;
  return section.moduleIds.indexOf(moduleId)<=section.moduleIds.indexOf(task.moduleId);
}
export function taskTitle(task,catalog) {
  if(!task)return '继续学习';
  if(task.kind==='module')return moduleItem(catalog,task.moduleId)?.title||task.moduleId;
  if(task.kind==='exercise'){const q=practiceItem(catalog,task.questionId);return `教材习题 ${q?.section||''} · ${q?.number||task.questionId}`;}
  if(task.kind==='blocked')return task.gapId?'尚缺内容的处理':'待核内容的处理';
  if(task.kind==='closing')return '本节收尾';
  return '本节试用已收尾';
}
