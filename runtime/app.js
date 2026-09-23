import { openStore } from './db.js';
import { validateBackup } from './state.js';
import { currentTask, sectionPlans, taskTitle } from './flow.js';

const base = new URL('../', import.meta.url);
const catalogURL = new URL('catalog.json', import.meta.url);
const params = new URLSearchParams(location.search);
const testName = params.get('test');
const testConfig = testName && /^[a-zA-Z0-9_-]{1,60}$/.test(testName) && window.__TOPOLOGY_TEST__ ? window.__TOPOLOGY_TEST__ : null;
const now = () => testConfig?.now || new Date().toISOString();
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uuid = () => crypto.randomUUID();
const fmt = iso => iso ? new Date(iso).toLocaleString('zh-CN', {hour12:false}) : '尚无排期';
let catalog, store, state, route = {view:'home'}, epoch = 0, busy = false, positionTimer, restoring = false, retryAction = null;
const drafts = new Map();
const htmlCache = new Map();
const sheet = document.querySelector('main.sheet');
const nav = document.querySelector('main.sheet > nav');
let view = document.getElementById('app-view');
let status = document.getElementById('save-status');
let errorBox = document.getElementById('runtime-error');

function fragments(html) {
  const t = document.createElement('template'); t.innerHTML = html || '';
  t.content.querySelectorAll('script,iframe,object,embed,form').forEach(n => n.remove());
  t.content.querySelectorAll('*').forEach(n => [...n.attributes].forEach(a => {
    if (/^on/i.test(a.name) || (['href','src'].includes(a.name) && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name);
  }));
  t.content.querySelectorAll('details').forEach(n => n.removeAttribute('open'));
  return t.content;
}
function content(node, html) { node.replaceChildren(fragments(html)); }
function button(text, fn, {primary=false, disabled=false, name=''}={}) {
  const b = document.createElement('button'); b.type='button'; b.textContent=text; b.disabled=disabled;
  if(primary) b.className='primary'; if(name) b.dataset.action=name; b.addEventListener('click', fn); return b;
}
function actions(parent) { const n=document.createElement('div'); n.className='runtime-actions'; parent.append(n); return n; }
function addHTML(parent, html, cls='') {const n=document.createElement('div'); n.className=cls; content(n,html); parent.append(n); return n;}
function task(){return currentTask(state,catalog);}
function plan(){return sectionPlans(catalog).find(s=>s.id===task()?.sectionId);}
function moduleById(id) {return catalog.modules.find(m=>m.id===id);}
function question(id) {return catalog.exercises.find(q=>q.id===id) || catalog.practice.find(q=>q.id===id) || catalog.reviews.find(q=>q.id===id);}
function activeAttempts(id) {return state.attempts.filter(a=>a.questionId===id&&!a.undoneAt);}
function lastAttempt(id) {return activeAttempts(id).at(-1);}
function draft(id) {if(!drafts.has(id)) drafts.set(id,{id:uuid(),help:false,answer:false,submitted:false}); return drafts.get(id);}
function renderStatus(message, error=false) {status.textContent=message;status.dataset.error=String(error);}
function showError(error, retry=null) {
  retryAction=retry; errorBox.hidden=false; errorBox.replaceChildren();
  const text=document.createElement('p');text.textContent=`操作未保存：${error?.message || error}。原有记录保留。`;errorBox.append(text);
  if(retry) errorBox.append(button('重试保存',()=>{const fn=retryAction;if(fn) fn();}));
  renderStatus('保存失败，请重试',true);
}
function clearError(){errorBox.hidden=true;errorBox.replaceChildren();retryAction=null;}
async function commit(action, after=null) {
  if(busy) return false;
  busy=true; renderStatus('正在保存…'); clearError();
  try {
    const next=await store.dispatch(action); if(!state||next.revision>=state.revision)state=next;
    renderStatus('已保存到当前浏览器');busy=false;
  } catch(e) {busy=false;showError(e,()=>commit(action,after));return false;}
  if(after)try{await after();}catch(e){errorBox.hidden=false;errorBox.textContent=`记录已保存，但页面显示失败：${e.message}。可刷新后继续。`;}
  return true;
}
function routeURL(r) {
  const url = new URL(r.view==='lesson' ? moduleById(r.moduleId).href : 'index.html',base);
  if(r.view==='lesson') url.searchParams.set('mode',r.mode||'browse');
  else if(r.view!=='home') url.searchParams.set('view',r.view);
  if(r.questionId)url.searchParams.set('question',r.questionId);
  if(r.helpFor)url.searchParams.set('helpFor',r.helpFor);
  if(testConfig)url.searchParams.set('test',testName);
  if(r.anchor)url.hash=r.anchor;
  return url;
}
function presentation() {
  if(restoring)return null;
  const node=view.querySelector('#boundary-content')||view.querySelector('#lesson-content');
  if(!node||!(route.view==='main'||route.view==='lesson'&&route.mode==='new'))return null;
  const kind=node.id==='boundary-content'?'block':'module',id=kind==='block'?node.dataset.blockId:node.dataset.moduleId;
  const expected=state.study?.block?.id||task()?.moduleId;
  if(id!==expected)return null;
  return {kind,id,scrollY:Math.round(window.scrollY),openDetails:[...node.querySelectorAll('details[open]')].map(d=>d.dataset.viewKey)};
}
function wirePresentation(node,id) {
  node.querySelectorAll('details').forEach((d,i)=>{d.dataset.viewKey=id+':d'+i;d.addEventListener('toggle',queuePosition);});
}
function queuePosition(){clearTimeout(positionTimer);if(!restoring)positionTimer=setTimeout(flushPosition,180);}
async function flushPosition(){
  clearTimeout(positionTimer);const p=presentation();
  if(p&&!busy&&JSON.stringify(p)!==JSON.stringify(state.study?.presentation))await commit({type:'presentation',presentation:p});
}
function restorePresentation(node,id,anchor='') {
  restoring=true;
  const p=state.study?.presentation;
  if(p?.id===id)node.querySelectorAll('details').forEach(d=>d.open=p.openDetails.includes(d.dataset.viewKey));
  requestAnimationFrame(()=>{
    if(p?.id===id)window.scrollTo(0,p.scrollY);
    else if(anchor)document.getElementById(anchor)?.scrollIntoView();
    else window.scrollTo(0,0);
    requestAnimationFrame(()=>{restoring=false;});
  });
}
window.addEventListener('scroll',queuePosition,{passive:true});

async function go(r,{push=true}={}) {
  clearTimeout(positionTimer); const n=++epoch;
  state=await store.read(); if(n!==epoch)return;
  route={...r}; clearError();
  if(route.view==='review')route={view:'main'};
  const t=task();
  if(route.view==='lesson'&&route.mode==='new'&&(state.study?.block||t?.moduleId!==route.moduleId))route={view:'main'};
  if(route.view==='main'&&!state.study?.block&&t?.kind==='module')route={view:'lesson',mode:'new',moduleId:t.moduleId,anchor:t.anchor||''};
  if(push) history.pushState({},'',routeURL(route));
  const navView=['home','main','lesson','review'].includes(route.view)?'home':route.view==='exercise'?'exercises':route.view;
  nav.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===navView));
  if(route.view==='main'){
    if(state.study?.block)renderBoundary();else renderMainTask();
  }else if(route.view==='home')renderHome();
  else if(route.view==='progress')renderProgress();
  else if(route.view==='exercises'||route.view==='exercise')renderExercises(route.questionId);
  else if(route.view==='lesson')await renderLesson(n);
  if(route.view!=='lesson'&&!(route.view==='main'&&state.study?.block))window.scrollTo(0,0);
}
async function continueCourse({schedule=true}={}){
  state=await store.read();
  if(!state.study&&!await commit({type:'syncContent'}))return;
  if(schedule&&!await commit({type:'continueSession'}))return;
  await go({view:'main'});
}
function renderHome(){
  view.innerHTML='<h1>拓扑课件 · 继续学习</h1>';
  const c=addHTML(view,`<h2>${state.study?.block?'知识点间隙 · 简短回顾':esc(taskTitle(task(),catalog))}</h2><p>同一知识点连续阅读讲解、A 与 B。题目自评留在原处，末尾再统一继续。</p>`,'runtime-card');
  actions(c).append(button('继续学习',continueCourse,{primary:true,name:'continue'}));
  addHTML(view,'<p class="runtime-small">普通题可选“会做／还不会”，未评价就保持未评价，不影响学完知识点。精选回顾和稍后的再练在知识点之间出现；没有新课时也可从这里巩固，不会打断未学完的知识点。</p>');
}
function renderMainTask() {
  const t=task(),section=plan();
  if(!t||!section){view.innerHTML='<p>当前没有可执行的课程安排。</p>';return;}
  if(t.kind==='exercise'){renderExercise(t.questionId);return;}
  view.innerHTML=`<h1>§${esc(section.number)} · ${esc(taskTitle(t,catalog))}</h1>`;
  if(t.kind==='blocked'){
    const gap=section.gaps?.find(g=>g.id===t.gapId),m=moduleById(t.moduleId),q=question(t.questionId);
    addHTML(view,`<h2>${esc(gap?.title||m?.title||q?.number||t.id)}</h2><p>${esc(gap?.reason||m?.statusText||q?.statusText||'内容缺失，暂不能安排正常讲练。')}</p><p>这是内容问题。可以暂缓后继续，不记为已学、已练习或答对。</p>`,'runtime-warning');
    if(gap)addHTML(view,`<p class="runtime-small">缺少课件：${esc(gap.moduleIds[0])}—${esc(gap.moduleIds.at(-1))}；相关原题 ${gap.exerciseIds.length} 项仍保留在覆盖表。</p>`);
    const a=actions(view);
    if(m)a.append(button('查看相关讲解与疑点',()=>go({view:'lesson',moduleId:m.id,mode:'browse'})));
    if(q)a.append(button('查看原题与疑点',()=>go({view:'exercise',questionId:q.id})));
    a.append(button('暂缓此内容，继续',()=>commit({type:'deferTask',taskId:t.id},()=>continueCourse({schedule:false})),{primary:true,name:'defer-task'}));
    return;
  }
  if(t.kind==='closing'){
    const count=section.requiredExercises.filter(id=>state.flow?.confirmations[id]).length;
    addHTML(view,`<p>本次安排的 ${section.requiredExercises.length} 个原题小问，保留旧版做过记录 ${count} 项。原题随对应知识点呈现；没有逐题自评门槛。</p><p>${esc(section.scopeNote)}</p>`);
    addHTML(view,`<h2>简短回顾</h2><p>${esc(section.closing?.overview||'本节已制作的讲练已完成本轮学习。')}</p>`);
    for(const id of section.closing?.summaryReviewIds||[]){const r=catalog.reviews.find(x=>x.id===id);if(r)addHTML(view,r.summaryHtml);}
    const deferred=Object.entries(state.flow.deferred).filter(([,d])=>d.sectionId===section.id);
    if(deferred.length)addHTML(view,`<p>本节保留 ${deferred.length} 处暂缓记录，暂缓不计作完成。${esc(section.closing?.coverageNote||'具体内容与状态见本节目录。')}</p>`,'runtime-warning');
    const next=sectionPlans(catalog).find(s=>s.id===section.nextSection?.id);
    addHTML(view,`<p>收尾后${next?'继续下一节':'返回当前课程边界'}，无需额外测试、订正或成功回忆。${!next&&section.nextSection?'下一节的制作状态见后续入口。':''}</p>`);
    actions(view).append(button('完成本节收尾，进入下一节',()=>commit({type:'closeSection',sectionId:section.id},()=>continueCourse({schedule:false})),{primary:true,name:'close-section'}));
    return;
  }
  addHTML(view,`<h2>${section.nextSection?`下一节：§${esc(section.nextSection.number)} ${esc(section.nextSection.title)}`:'现有课程已完成本轮学习'}</h2><p>${section.nextSection?esc(section.nextSection.statusText||'下一节尚无可执行课件。'):'当前没有新的知识点。'}可继续从“继续学习”安排到期巩固；已有学习和暂缓记录保留。</p>`,'runtime-card');
  actions(view).append(button('查看本节记录与覆盖情况',()=>go({view:'progress'})));
}
async function lessonHTML(m) {
  if(!htmlCache.has(m.href)) {
    const res=await fetch(new URL(m.href,base),{cache:'no-cache'});if(!res.ok)throw new Error('课件文件读取失败');
    const doc=new DOMParser().parseFromString(await res.text(),'text/html');
    const article=doc.getElementById('lesson-content');if(!article)throw new Error('课件缺少稳定正文容器，请重新构建');
    htmlCache.set(m.href,article.innerHTML);
  }
  return htmlCache.get(m.href);
}
async function renderLesson(n) {
  const m=moduleById(route.moduleId);if(!m){view.innerHTML='<p>没有找到课件，请从目录选择。</p>';return;}
  view.innerHTML='<p>正在读取课件…</p>';
  try {
    const html=await lessonHTML(m);if(n!==epoch)return;
    view.replaceChildren();
    const top=addHTML(view,`<div class="runtime-status-line"><span>${route.mode==='new'?'新课讲练':'临时回看'}</span><span>制作状态：${m.status==='usable'?'可用':'待核验'}</span><span>本轮学习：${state.modules[m.id]?.completedAt?'已完成':state.modules[m.id]?.startedAt?'进行中':'未开始'}</span></div>`,'runtime-toolbar');
    if(m.status!=='usable')addHTML(top,`<p>${esc(m.statusText||'本课存在需要核查的说明。可查阅，不计入正常完成与排期。')}</p>`,'runtime-warning');
    const a=actions(top);
    if(route.mode==='browse')a.append(button('继续学习',continueCourse,{name:'return-course'}));

    const article=document.createElement('article');article.id='lesson-content';article.dataset.moduleId=m.id;article.append(fragments(html));view.append(article);
    if(route.mode==='new')for(const id of m.practice)drafts.delete(id);
    wireLesson(article,m);
    if(route.mode==='new'&&m.status==='usable') {
      if(!state.modules[m.id]?.startedAt)await commit({type:'start',moduleId:m.id});
      if(state.modules[m.id]?.startedAt)top.querySelector('.runtime-status-line span:last-child').textContent='本轮学习：进行中';
      const section=plan();
      const exerciseStart=section.moduleIds.indexOf(section.exerciseStartModule);
      const isExercise=exerciseStart>=0&&section.moduleIds.indexOf(m.id)>=exerciseStart;
      addHTML(top,`<p class="runtime-small">§${esc(section.number)} · ${isExercise?'本节教材习题与配套讲练':'微模块讲练'} → 本节收尾。当前只需完成本模块的讲练。</p>`);
      const bottom=addHTML(view,'<p>本轮学到这里即可继续。题目可以不评价；还不会也不需要订正或通关。</p>','runtime-toolbar');
      actions(bottom).append(button('本知识点学完，继续',()=>{
        clearTimeout(positionTimer);
        commit({type:'complete',moduleId:m.id},()=>continueCourse({schedule:false}));
      },{primary:true,name:'complete-module'}));
    }
    wirePresentation(article,m.id);
    if(route.mode==='new')restorePresentation(article,m.id,route.anchor||'');
    else {restoring=false;window.scrollTo(0,0);if(route.anchor)document.getElementById(route.anchor)?.scrollIntoView();}
  }catch(e){showError(e);}
}
function wireLesson(article,m) {
  const controls=[...article.querySelectorAll('.practice-controls[data-question-id]')];
  controls.forEach(el=>{
    const id=el.dataset.questionId,q=question(id); if(!q)return;
    if(route.mode!=='new'){el.remove();return;}
    renderPracticeControls(el,q,m.kind==='check'?'stage':'guided');
    const ans=document.getElementById(q.answerAnchor||`answer-${id}`);
    let d=ans?.tagName==='DETAILS'?ans:ans?.querySelector('details');
    if(!d){let node=ans?.nextElementSibling;for(let i=0;node&&i<4;i++,node=node.nextElementSibling){if(node.tagName==='DETAILS'){d=node;break;}}}
    if(d?.tagName==='DETAILS')d.addEventListener('toggle',()=>{if(d.open)draft(id).answer=true;});
  });
  article.querySelectorAll('details').forEach(d=>d.addEventListener('toggle',()=>{
    if(d.open&&/展开.*A|A.*解答|示范/.test(d.querySelector('summary')?.textContent||''))controls.forEach(el=>draft(el.dataset.questionId).help=true);
  }));
  article.querySelectorAll('a[href]').forEach(a=>a.addEventListener('click',ev=>{
    const u=new URL(a.getAttribute('href'),location.href);
    const target=catalog.modules.find(x=>new URL(x.href,base).pathname===u.pathname);
    if(target){ev.preventDefault();go({view:'lesson',mode:'browse',moduleId:target.id,anchor:decodeURIComponent(u.hash.slice(1))});}
  }));
}
function renderAssessment(el,q,mode,answer=null) {
  const block=state.study?.block,item=block?.items.find(x=>x.id===q.id);
  const dr=mode==='review'||mode==='retry'?{id:uuid(),answer:false,help:false}:draft(q.id);
  addHTML(el,`<p class="runtime-small">${mode==='review'?'按查看答案前是否想起来自评。': '请按查看参考解前的实际表现自评；也可以不评价。'}</p>`);
  const row=actions(el),statusLine=document.createElement('p');statusLine.className='assessment-status runtime-small';statusLine.dataset.assessmentStatus=q.id;
  const current=()=>mode==='retry'||mode==='review'?state.attempts.find(a=>a.id===state.study?.block?.items.find(x=>x.id===q.id)?.attemptId&&!a.undoneAt):lastAttempt(q.id);
  const refresh=()=>{const a=current();statusLine.textContent=a?`已记录：${a.rating==='good'?(mode==='review'?'想起来了':'会做'):(mode==='review'?'没想起来':'还不会')}`:'尚未评价';};
  const submitted=!!item?.attemptId;
  const apply=rating=>{
    const snap=presentation();
    commit({type:'score',questionId:q.id,mode,rating,submissionId:dr.id,helpViewed:dr.help,answerViewed:dr.answer,...(snap?{presentation:snap}:{})},()=>{
      refresh();again.disabled=good.disabled=true;
      (rating==='good'?good:again).setAttribute('aria-pressed','true');
      const summary=el.parentElement.querySelector('.after-assessment');if(summary)summary.hidden=false;
    });
  };
  const again=button(mode==='review'?'没想起来':'还不会',()=>apply('again'),{name:mode==='review'?'review-again':'rate-again',disabled:submitted||mode==='review'});
  const good=button(mode==='review'?'想起来了':'会做',()=>apply('good'),{name:mode==='review'?'review-good':'rate-good',disabled:submitted||mode==='review'});
  if(answer)answer.addEventListener('toggle',()=>{if(answer.open){dr.answer=true;if(mode==='review'&&!current())again.disabled=good.disabled=false;}});
  row.append(good,again);el.append(statusLine);refresh();
}
function renderPracticeControls(el,q,mode) {
  el.replaceChildren();
  const original=catalog.exercises.find(e=>e.id===q.id);
  if(original)addHTML(el,`<p class="runtime-small">教材原题 · 第 ${esc(original.page)} 页 · 习题 ${esc(original.section)} ${esc(original.number)}。${esc(original.practiceGoal)}</p>`);
  else addHTML(el,`<p class="runtime-small">${mode==='stage'?'新增阶段任务':'新增练习 B'} · ${esc(q.id)}</p>`);
  if(q.status!=='usable'){addHTML(el,'<p>内容待核验，暂不自评。</p>');return;}
  renderAssessment(el,q,mode);
}
function renderExercises(targetId=null) {
  view.innerHTML='<h1>教材习题 · 参考资料</h1><p>按教材顺序连续查阅题设、小问和参考解。这里不评分、不记录完成，也不改变主线位置。</p>';
  const groups=new Map();for(const q of catalog.exercises){if(!groups.has(q.parentId))groups.set(q.parentId,[]);groups.get(q.parentId).push(q);}
  let section='';
  for(const [parentId,items] of groups){
    const q=items[0];
    if(q.section!==section){section=q.section;addHTML(view,`<h2>第 ${esc(section.split('.')[0])} 章 · 习题 ${esc(section)}</h2>`);}
    const group=addHTML(view,`<h3>第 ${esc(q.groupNumber)} 题 · 书内第 ${esc(q.page)} 页</h3>`,'reference-group');group.id='reference-'+parentId;
    const pending=items.some(x=>x.status==='pending');
    if(pending)addHTML(group,'<p>本题原文语义待核，以下保留共同条件、疑点和有适用条件的参考解。</p>','runtime-warning');
    if(q.groupHtml){
      // Exercise 3's extracted group deliberately stores context separately.
      if(pending&&q.contextHtml)addHTML(group,q.contextHtml);
      addHTML(group,q.groupHtml);
    }else if(q.status==='unwritten')addHTML(group,'<p>完整题干及解答尚未制作，当前仅保留题号位置。</p>');
    else {
      addHTML(group,q.contextHtml||'');addHTML(group,q.questionHtml);
      const d=document.createElement('details');d.innerHTML='<summary>展开参考解</summary>';d.append(fragments(q.answerHtml));group.append(d);
    }
  }
  if(targetId){const q=question(targetId);if(q)requestAnimationFrame(()=>document.getElementById('reference-'+q.parentId)?.scrollIntoView());}
}
function renderExercise(id){renderExercises(id);}
function renderBoundary(){
  const block=state.study.block;
  view.innerHTML='<h1>知识点间隙 · 简短回顾</h1><p>先尝试回忆或再做一次，再展开答案、自评。评价后停在原处；本段末尾统一继续，没评价也可以继续。</p>';
  const area=document.createElement('article');area.id='boundary-content';area.dataset.blockId=block.id;view.append(area);
  for(const item of block.items){
    const q=question(item.id),card=addHTML(area,`<h2>${item.kind==='retry'?'稍后再练':'精选关键点'} · ${esc(item.id)}</h2>`,'runtime-card');card.dataset.reviewId=item.id;
    if(!q||q.status!=='usable'||q.version!==item.version){addHTML(card,'<p>本项内容缺失或版本已变，暂停自评；可以直接继续。</p>');continue;}
    addHTML(card,q.contextHtml||'');addHTML(card,q.questionHtml,'review-question');
    const answer=document.createElement('details');answer.innerHTML='<summary>尝试后展开答案</summary>';answer.append(fragments(q.answerHtml));card.append(answer);
    const controls=document.createElement('div');controls.className='practice-controls';card.append(controls);renderAssessment(controls,q,item.kind,answer);
    if(q.summaryHtml){const summary=addHTML(card,'<h3>简短小结</h3>'+q.summaryHtml,'after-assessment');summary.hidden=!item.attemptId;}
  }
  actions(area).append(button('继续',()=>commit({type:'finishBoundary',blockId:block.id},()=>continueCourse({schedule:false})),{primary:true,name:'finish-boundary'}));
  wirePresentation(area,block.id);restorePresentation(area,block.id);
}
function renderProgress() {
  const mods=catalog.modules.filter(m=>m.kind==='module'),usable=mods.filter(m=>m.status==='usable'),done=usable.filter(m=>state.modules[m.id]?.completedAt);
  view.innerHTML=`<h1>目录与进度</h1><p>当前可用微模块中，本轮已完成 <strong>${done.length} / ${usable.length}</strong>。另有 ${mods.filter(m=>m.status!=='usable').length} 个已编写待核模块；未生成章节仍待制作。</p><p class="runtime-small">制作状态与学习状态分别列出，不显示整体掌握率。</p>`;
  for(const section of sectionPlans(catalog)){
    const count=section.requiredExercises.filter(id=>state.flow?.confirmations[id]).length;
    const c=addHTML(view,`<h2>§${esc(section.number)} 本次安排</h2><p>${esc(section.scopeNote)}</p><p>旧版原题做过证据：${count} 项，仅保留历史，不代表会做。</p><p>当前任务：${esc(taskTitle(task(),catalog))}。从目录继续学习时，会带回尚未结束的知识点；已学内容始终可以回看。</p>`,'runtime-card');
    for(const id of section.requiredExercises){const q=question(id);addHTML(c,`<p class="runtime-small">原题 ${esc(q?.number)} · ${state.flow?.confirmations[id]?'有旧版做过记录':'不要求逐题确认'}</p>`);}
    for(const [id,d] of Object.entries(state.flow?.deferred||{}))if(d.sectionId===section.id)addHTML(c,`<p class="runtime-small">已暂缓（内容问题）：${esc(id)} · ${esc(fmt(d.at))}，未记为学过或做过。</p>`);
  }
  const list=document.createElement('ul');list.className='runtime-list';view.append(list);
  for(const m of catalog.modules){
    const prog=state.modules[m.id],li=document.createElement('li');
    li.innerHTML=`<strong>${esc(m.id)} · ${esc(m.title)}</strong><p class="runtime-small">制作：${m.status==='usable'?'可用':'待核验'}；个人：${prog?.completedAt?'已完成本轮':prog?.startedAt?'进行中':'未开始'}${m.kind==='check'?' · 阶段任务':''}</p>`;
    const a=actions(li);a.append(button('打开回看',()=>go({view:'lesson',moduleId:m.id,mode:'browse'})));
    if(m.status==='usable'&&!m.delayed)a.append(button('从这里继续学习',()=>continueCourse({schedule:false})));
    list.append(li);
  }
  const settings=addHTML(view,`<h2>讲练间隙</h2><label>每学完 <input type="number" id="review-every" min="1" max="20" value="${state.settings.reviewEvery}"> 个新知识点，检查精选 FSRS 回顾</label><p class="runtime-small">只计首次完成的知识点，自评、查资料和重复完成不增加次数。达到次数而暂无可安排项目时，后续知识点结束会继续检查；只有实际呈现精选 FSRS 项的块才重新计数；普通再练单独成块不会清零。课间重新开始或无新课时，也会检查到期巩固。</p><label>每次精选 FSRS 上限 <input type="number" id="review-limit" min="1" max="10" value="${state.settings.reviewLimit}"> 项（实际最多 2 项）</label><p class="runtime-small">普通题再练在知识点结束时另行检查，最多另加 1 项，不占上述上限。因此上限设为 1 时合计最多 2 项，设为 2 或更大时合计最多 3 项；不要求做完或答对才能继续。</p>`,'runtime-card');
  actions(settings).append(button('保存间隙设置',()=>commit({type:'settings',reviewEvery:Number(settings.querySelector('#review-every').value),reviewLimit:Number(settings.querySelector('#review-limit').value)})));
  const backups=addHTML(view,'<h2>备份与恢复</h2><p>备份包含继续位置、完成状态、作答日志、精选复习卡及设置。更换浏览器或清除网站数据前，请先导出。</p>','runtime-card');
  addHTML(backups,'<p class="runtime-small">“导出备份”保存当前进度。“升级前备份”只在本浏览器首次把已有旧状态写成连续学习格式时保留一次，不随以后的学习更新；新用户或仅查资料时不会生成。它不能代替当前进度备份。</p>');
  const a=actions(backups);a.append(button('导出备份',()=>exportBackup(),{name:'export-backup'}),button('导出升级前备份',()=>exportBackup(true),{name:'export-before-upgrade'}));
  const input=document.createElement('input');input.type='file';input.accept='.json,application/json';input.id='backup-file';input.setAttribute('aria-label','选择学习记录备份');backups.append(input);
  const importArea=document.createElement('div');backups.append(importArea);
  input.addEventListener('change',async()=>{
    importArea.replaceChildren();const file=input.files[0];if(!file)return;
    try {
      if(file.size>20*1024*1024)throw new Error('备份超过20MB，请先检查文件');
      const backup=JSON.parse(await file.text()),result=validateBackup(backup,catalog);
      const c=addHTML(importArea,`<h3>已校验，等待你确认替换</h3><p>此备份含 ${result.state.attempts.length} 条自评事件、${Object.keys(result.state.flow?.confirmations||{}).length} 道练习确认及 ${Object.keys(result.state.flow?.deferred||{}).length} 处内容暂缓。替换会覆盖当前浏览器的现有学习记录。</p><p>${esc((result.warnings||[]).join('；'))}</p>`,'runtime-confirm');
      const aa=actions(c);aa.append(button('先导出当前备份',()=>exportBackup()),button('确认替换当前学习记录',async()=>{
        if(busy)return;busy=true;renderStatus('正在恢复…');
        try{const r=await store.replace(backup);state=r.state;drafts.clear();busy=false;renderStatus('备份已恢复并保存');await go({view:'progress'});}
        catch(e){busy=false;showError(e);}
      },{name:'confirm-restore'}),button('取消',()=>{importArea.replaceChildren();input.value='';}));
    }catch(e){addHTML(importArea,`<p>备份无效，未修改现有记录：${esc(e.message)}</p>`,'runtime-error');}
  });
  if(navigator.storage?.persist)a.append(button('申请浏览器持久保存',async()=>{
    const ok=await navigator.storage.persist();addHTML(backups,`<p class="runtime-small">${ok?'浏览器已允许持久保存。':'浏览器未授予持久保存。'}仍建议定期导出备份。</p>`);
  }));
  if(state.attempts.some(x=>!x.undoneAt)){
    addHTML(backups,'<p class="runtime-small">撤销作用于全部题目中最近一条尚未撤销的自评（普通题、再练或 FSRS）。它保留撤销痕迹；FSRS 恢复评分前卡片，普通题按上一条有效自评重新安排再练。不撤销知识点完成，也不倒退主线位置。</p>');
    actions(backups).append(button('撤销最近一次评分',()=>commit({type:'undo'},()=>renderProgress()),{name:'undo-score'}));
  }
}
async function exportBackup(beforeUpgrade=false) {
  try{
    const backup=await (beforeUpgrade?store.exportBeforeUpgrade():store.exportBackup()),text=JSON.stringify(backup,null,2),blob=new Blob([text],{type:'application/json'}),url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download=`拓扑学习备份-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);renderStatus('已生成备份文件，请确认浏览器已保存');
  }catch(e){showError(e);}
}
function fromLocation() {
  const p=new URLSearchParams(location.search),file=decodeURIComponent(location.pathname.split('/').pop());
  const m=catalog.modules.find(x=>x.href.split('/').pop()===file);
  if(m)return {view:'lesson',moduleId:m.id,mode:p.get('mode')==='new'?'new':'browse',anchor:decodeURIComponent(location.hash.slice(1)),helpFor:p.get('helpFor')||undefined};
  return {view:p.get('view')||'home',questionId:p.get('question')||undefined};
}
async function boot() {
  if(!view){view=document.createElement('div');view.id='app-view';sheet.append(view);}
  if(!status){status=document.createElement('p');status.id='save-status';status.setAttribute('role','status');nav.after(status);}
  if(!errorBox){errorBox=document.createElement('div');errorBox.id='runtime-error';errorBox.className='runtime-error';errorBox.setAttribute('role','alert');errorBox.hidden=true;status.after(errorBox);}
  const response=await fetch(catalogURL,{cache:'no-cache'});if(!response.ok)throw new Error('课程索引读取失败，请重新启动');catalog=await response.json();
  store=await openStore({name:testConfig?`topology-test-${testName}`:'topology-learning-v1',catalog,clock:now,failWrites:()=>!!testConfig?.failWrites});state=await store.read();
  if(!['exercises','exercise'].includes(new URLSearchParams(location.search).get('view')))state=await store.dispatch({type:'syncContent'});
  nav.className='runtime-nav';nav.replaceChildren();
  [['继续学习','home'],['教材习题（资料）','exercises'],['目录与进度','progress']].forEach(([label,v])=>{const b=button(label,()=>v==='home'?continueCourse():go({view:v}));b.dataset.view=v;nav.append(b);});
  if(testConfig){const n=document.createElement('div');n.className='runtime-test';n.textContent='测试数据环境：与正式学习记录隔离';sheet.prepend(n);window.__TOPOLOGY_APP__={store,catalog,get state(){return state;},go,refresh:async()=>{state=await store.read();await go({...route},{push:false});}};}
  const r=fromLocation();await go(r,{push:false});
  store.subscribe(async()=>{
    if(busy)return;
    const fresh=await store.read();
    if(fresh.revision===state.revision)return;
    state=fresh;
    // Another tab must not tear down the lesson under a reader's cursor.
    view.querySelectorAll('[data-assessment-status]').forEach(el=>{const a=lastAttempt(el.dataset.assessmentStatus);if(a)el.textContent='已记录：'+(a.rating==='good'?'会做':'还不会');});
  });
  window.addEventListener('popstate',()=>go(fromLocation(),{push:false}));

}
boot().catch(e=>{if(!errorBox){errorBox=document.createElement('div');errorBox.className='runtime-error';sheet.prepend(errorBox);}errorBox.hidden=false;errorBox.textContent=`学习功能启动失败：${e.message}。未改动学习记录；请重新启动或重试。`;});
