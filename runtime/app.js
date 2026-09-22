import { openStore } from './db.js';
import { getReviewQueue, validateBackup } from './state.js';
import { currentTask, sectionPlans, taskTitle, confirmed, canBrowse, moduleQuestions } from './flow.js';

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
function point(){const t=task();return {moduleId:t?.moduleId||null,anchor:t?.anchor||''};}
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
function currentAnchor() {
  if(route.view!=='lesson')return '';
  const allowed=new Set((moduleById(route.moduleId)?.anchors||[]).map(a=>a.id));
  const nodes=[...view.querySelectorAll('#lesson-content h2[id], #lesson-content h3[id]')].filter(n=>allowed.has(n.id));
  let anchor='';for(const n of nodes){if(n.getClientRects().length&&n.getBoundingClientRect().height>0&&n.getBoundingClientRect().top<=150)anchor=n.id;}
  return anchor;
}
async function flushPosition() {
  clearTimeout(positionTimer);
  if(route.view==='lesson'&&route.mode==='new'&&!restoring&&!busy&&view.querySelector('#lesson-content')?.dataset.moduleId===route.moduleId){
    const anchor=currentAnchor();
    if(state.newCourse?.moduleId===route.moduleId&&state.newCourse.anchor!==anchor)
      await commit({type:'position',moduleId:route.moduleId,anchor});
  }
}
window.addEventListener('scroll',()=>{
  clearTimeout(positionTimer);
  if(route.view==='lesson'&&route.mode==='new'&&!restoring) positionTimer=setTimeout(flushPosition,220);
},{passive:true});

async function go(r,{push=true,offer=false}={}) {
  await flushPosition(); const n=++epoch;
  state=await store.read(); if(n!==epoch)return;
  route={...r}; clearError();
  const t=task();
  if(route.view==='lesson' && ((route.mode==='new'&&(t?.kind!=='module'||t.moduleId!==route.moduleId)) ||
      (route.mode!=='new'&&!route.helpFor&&!canBrowse(state,catalog,route.moduleId)))) route={view:'main'};
  if(route.view==='main' && t?.kind==='module')route={view:'lesson',mode:'new',moduleId:t.moduleId,anchor:t.anchor||''};
  if(push) history.pushState({},'',routeURL(route));
  const navView=['home','main','lesson','review'].includes(route.view)?'home':route.view==='exercise'?'exercises':route.view;
  nav.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===navView));
  if(route.view==='main'){
    if(offer&&state.counter.completedSincePrompt>=state.settings.reviewEvery&&!state.reviewSession&&getReviewQueue(state,catalog,now()).ids.length)renderOffer();
    else renderMainTask();
  }
  else if(route.view==='home')renderHome();
  else if(route.view==='progress')renderProgress();
  else if(route.view==='exercises')renderExercises();
  else if(route.view==='exercise')renderExercise(route.questionId);
  else if(route.view==='review')renderReview();
  else if(route.view==='lesson') {
    if(offer&&state.counter.completedSincePrompt>=state.settings.reviewEvery&&route.mode==='new'&&!state.reviewSession&&getReviewQueue(state,catalog,now()).ids.length)renderOffer();
    else await renderLesson(n);
  }
  if(route.view!=='lesson'||!route.anchor)window.scrollTo(0,0);
}
async function continueCourse({offer=true,resumeReview=true}={}) {
  state=await store.read();
  if(resumeReview&&state.reviewSession){await go({view:'review'});return;}
  await go({view:'main'},{offer:offer&&state.counter.completedSincePrompt>=state.settings.reviewEvery});
}
async function returnCourse(savedPoint=null) {
  const saved=state.reviewSession?.returnTask;
  if(saved && task()?.id!==saved.id)renderStatus('主线已在其他入口更新，返回当前待办；原复习返回点保留在复习记录中。');
  await continueCourse({offer:false,resumeReview:false});
}
function renderHome() {
  view.innerHTML='<h1>拓扑课件 · 继续学习</h1>';
  const t=task(),section=plan();
  const card=addHTML(view,`<h2>${esc(taskTitle(t,catalog))}</h2><p>讲练 → 本节教材习题 → 本节收尾 → 下一节。按自己的实际尝试确认完成，不要求答对或订正。</p>`,'runtime-card');
  actions(card).append(button(state.reviewSession?'继续学习 · 恢复复习':'继续学习',()=>continueCourse(),{primary:true,name:'continue'}));
  if(section)addHTML(view,`<p class="runtime-small">§${esc(section.number)} ${esc(section.title)} · ${esc(section.scopeNote)}</p>`);
  const q=getReviewQueue(state,catalog,now());
  addHTML(view,`<p class="runtime-small">精选关键点将在自然间隙出现：已到期 ${q.due.length} 项，待首次巩固 ${q.new.length} 项。可以稍后，不影响推进。</p>`);
  if(state.flow?.legacyPosition)addHTML(view,'<p class="runtime-small">旧学习记录已保留。旧自评不自动变成本轮练习确认；已明确完成的模块无需重学，原题的待确认项由主线带回。</p>');
  addHTML(view,'<p class="runtime-small">记录保存在当前浏览器。辅助入口可查题、回看或备份，日常只需继续学习。</p>');
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
    a.append(button('暂缓此内容，继续',()=>commit({type:'deferTask',taskId:t.id},()=>continueCourse({offer:false,resumeReview:false})),{primary:true,name:'defer-task'}));
    return;
  }
  if(t.kind==='closing'){
    const count=section.requiredExercises.filter(id=>confirmed(state,id)).length;
    addHTML(view,`<p>本次安排的 ${section.requiredExercises.length} 个原题小问，已确认练习 ${count} 项。完成确认只表示本轮做过，不代表已掌握。</p><p>${esc(section.scopeNote)}</p>`);
    addHTML(view,'<h2>简短回顾</h2><p>本段沿拓扑的定义、有限例子、一般离散性证明，再到有限簇判别和有限交证明推进。</p>');
    for(const id of ['T01-01-R006','T01-01-R010']){const r=catalog.reviews.find(x=>x.id===id);if(r)addHTML(view,r.summaryHtml);}
    const deferred=Object.entries(state.flow.deferred).filter(([,d])=>d.sectionId===section.id);
    if(deferred.length)addHTML(view,`<p>本次仍有 ${deferred.length} 处内容暂缓（包含原题 3 的待核内容及未制作部分），不计作完成。习题 5—9、阶段检查与其他覆盖项继续保留在辅助入口和课程目录中。</p>`,'runtime-warning');
    addHTML(view,'<p>本次试用收尾后可进入下一节入口，无需额外测试、订正或成功回忆。当前下一节课件尚缺失，入口会如实显示待制作。</p>');
    actions(view).append(button('完成本节收尾，进入下一节',()=>commit({type:'closeSection',sectionId:section.id},()=>continueCourse({offer:false,resumeReview:false})),{primary:true,name:'close-section'}));
    return;
  }
  addHTML(view,`<h2>下一节：§${esc(section.nextSection?.number)} ${esc(section.nextSection?.title)}</h2><p>本节试用流程已收尾。下一节课件尚未制作，暂时不能开始；这不是成绩门槛。已暂缓内容和已有记录全部保留。</p>`,'runtime-card');
  actions(view).append(button('查看本节记录与覆盖情况',()=>go({view:'progress'})));
}
function reviewOfferContents(parent) {
  const q=getReviewQueue(state,catalog,now());
  addHTML(parent,`<h2>在继续前，回忆几个关键点</h2><p>本次建议 ${q.ids.length} 项；队列中已到期 ${q.due.length} 项、待首次巩固 ${q.new.length} 项。</p><p class="runtime-small">可以稍后；这不会改变原有排期或产生评分。</p>`);
  const a=actions(parent);
  a.append(button('开始本组',()=>commit({type:'beginReview',sessionId:uuid(),ids:q.ids},()=>go({view:'review'})),{primary:true,name:'begin-review'}));
  a.append(button('稍后复习，继续当前任务',()=>commit({type:'deferReview'},()=>continueCourse({offer:false,resumeReview:false})),{name:'defer-review'}));
}
function renderOffer(){view.innerHTML='<h1>讲练间隙</h1>';reviewOfferContents(view);}

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
    if(route.mode==='browse'&&m.status==='usable'&&!m.delayed)a.append(button('继续学习',()=>continueCourse({offer:false,resumeReview:false}),{name:'set-new-course'}));
    if(route.mode==='browse')a.append(button('返回当前任务',()=>continueCourse({offer:false,resumeReview:false}),{name:'return-course'}));
    if(state.reviewSession)a.append(button('恢复未结束的复习',()=>go({view:'review'})));
    const article=document.createElement('article');article.id='lesson-content';article.dataset.moduleId=m.id;article.append(fragments(html));view.append(article);
    wireLesson(article,m);
    if(route.mode==='new'&&m.status==='usable') {
      if(!state.modules[m.id]?.startedAt)await commit({type:'start',moduleId:m.id});
      if(state.modules[m.id]?.startedAt)top.querySelector('.runtime-status-line span:last-child').textContent='本轮学习：进行中';
      const section=plan();
      const isExercise=section.moduleIds.indexOf(m.id)>=section.moduleIds.indexOf(section.exerciseStartModule);
      addHTML(top,`<p class="runtime-small">§${esc(section.number)} · ${isExercise?'本节教材习题与配套讲练':'微模块讲练'} → 本节收尾。当前只需完成本模块的讲练。</p>`);
      const bottom=addHTML(view,'<p>请在每道 B 题处确认“本题已练习，继续”。不会、做错或看过解答都可以继续；无需输入答案、订正或等待。</p>','runtime-toolbar');
      actions(bottom).append(button('继续学习',async()=>{
        const remaining=m.practice.find(id=>!confirmed(state,id));
        if(remaining){const el=article.querySelector(`[data-question-id="${remaining}"]`);el?.scrollIntoView();return;}
        await commit({type:'complete',moduleId:m.id},()=>continueCourse({resumeReview:false}));
      },{name:'complete-module'}));
    }
    const anchor=route.anchor||'';restoring=true;
    requestAnimationFrame(()=>{
      const target=anchor&&document.getElementById(anchor);if(target)target.scrollIntoView();else window.scrollTo(0,0);
      setTimeout(()=>{restoring=false;},350);
    });
  }catch(e){showError(e);}
}
function wireLesson(article,m) {
  const controls=[...article.querySelectorAll('.practice-controls[data-question-id]')];
  controls.forEach(el=>{
    const id=el.dataset.questionId,q=question(id); if(!q)return;
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
function historyHTML(qid) {
  const list=activeAttempts(qid),last=list.at(-1);
  if(!last)return '<p class="runtime-history">这道题尚无作答记录。</p>';
  const modes={guided:'跟随课件讲练',direct:'直接做原题',review:'计分复习',stage:'阶段任务'};
  return `<p class="runtime-history">已记录 ${list.length} 次真实尝试；最近：${last.rating==='good'?'做出来了':'需要再练'} · ${esc(modes[last.mode]||last.mode)}${last.helpViewed?'（查看过帮助）':''} · ${esc(fmt(last.at))}</p>`;
}
function renderPracticeControls(el,q,mode) {
  el.replaceChildren();
  const original=catalog.exercises.find(e=>e.id===q.id);
  if(original)addHTML(el,`<p class="runtime-small">教材原题 · 书内第 ${esc(original.page)} 页 · 习题 ${esc(original.section)} ${esc(original.number)}<br>对应知识点：${esc(original.knowledge)}<br>主要练习：${esc(original.practiceGoal)}</p>`);
  else addHTML(el,`<p class="runtime-small">${mode==='stage'?'新增阶段任务（可选）':'课程新增练习 B'} · ${esc(q.id)}</p>`);
  if(q.status!=='usable')addHTML(el,'<p>本题待核或内容未齐，不能记为正常完成。主线会提供暂缓入口。</p>');
  const a=actions(el),dr=draft(q.id);
  if(q.status==='usable'){
    if(confirmed(state,q.id)){
      addHTML(el,'<p class="runtime-history">本题本轮已确认练习（不代表答对或掌握）；主线与题库共享记录，无需重复确认。</p>');
      a.append(button('已确认，继续当前任务',()=>continueCourse({offer:false,resumeReview:false}),{name:'confirmed-continue'}));
    }else{
      addHTML(el,'<p>可以在纸上、iPad 或脑中尝试，再自行查看参考解。是否完成本轮由你确认，不要求做对或看过答案。</p>');
      a.append(button('本题已练习，继续',()=>commit({type:'confirmPractice',questionId:q.id,submissionId:dr.id,mode,helpViewed:dr.help,answerViewed:dr.answer},()=>continueCourse({resumeReview:false})),{primary:true,name:'confirm-practice'}));
    }
  }
  a.append(button(state.flags[q.id]?'取消以后再看':'以后再看',()=>commit({type:'flag',questionId:q.id,remove:!!state.flags[q.id],note:'以后再看'},()=>renderPracticeControls(el,q,mode)),{name:'flag-question'}));
  if(activeAttempts(q.id).length)addHTML(el,'<p class="runtime-small">以下为旧版自评历史，与本轮完成确认分别保留。</p>'+historyHTML(q.id));
}
function renderExercises() {
  view.innerHTML='<h1>教材习题</h1><p>按教材位置查找原题。课件里的同一道题共享这里的记录；查阅原题不会覆盖新课位置。</p>';
  const filters=addHTML(view,'<label>范围 <select id="exercise-filter"><option value="all">本节全部题目</option><option value="ready">当前可用</option><option value="again">需要再练</option><option value="flag">有疑问</option></select></label>','runtime-filters');
  const count=document.createElement('p');count.className='runtime-small';view.append(count);
  const list=document.createElement('ul');list.className='runtime-list';view.append(list);
  function fill() {
    const mode=filters.querySelector('select').value;
    const done=new Set(catalog.exercises.filter(q=>confirmed(state,q.id)).map(q=>q.id));
    count.textContent=`本轮已确认 ${done.size} 道原题小问；当前索引 ${catalog.exercises.length} 项，制作状态单独显示。`;
    list.replaceChildren();
    for(const q of catalog.exercises){
      if(mode==='ready'&&q.status!=='usable'||mode==='again'&&lastAttempt(q.id)?.rating!=='again'||mode==='flag'&&!state.flags[q.id])continue;
      const li=document.createElement('li');
      li.innerHTML=`<strong>习题 ${esc(q.section)} · ${esc(q.number)}</strong><span class="runtime-pill ${q.status==='usable'?'':'pending'}">${q.status==='usable'?'可用':q.status==='unwritten'?'待编写':'待核验'}</span><p class="runtime-small">书内第 ${esc(q.page||'—')} 页 · ${confirmed(state,q.id)?'本轮已确认练习':'本轮未确认'} · ${sectionPlans(catalog).some(s=>s.requiredExercises.includes(q.id))?'本次必做':'本次不设门槛，保留覆盖'}</p>`;
      const a=actions(li);a.append(button(q.status==='unwritten'?'内容尚未编写':'打开原题',()=>go({view:'exercise',questionId:q.id}),{}));list.append(li);
    }
    if(!list.children.length)list.innerHTML='<li class="runtime-empty">此筛选下没有题目。</li>';
  }
  filters.querySelector('select').addEventListener('change',fill);fill();
}
function renderExercise(id) {
  const q=catalog.exercises.find(x=>x.id===id); if(!q){view.innerHTML='<p>未找到该原题。</p>';return;}
  view.innerHTML=`<h1>习题 ${esc(q.section)} · ${esc(q.number)}</h1><p class="runtime-meta">书内第 ${esc(q.page)} 页 · ${esc(q.id)}</p>`;
  if(q.status==='unwritten'){addHTML(view,'<p>这一小问的完整课件、题干与解答尚未编写，保留覆盖位置，不记为完成。</p>');actions(view).append(button('返回当前任务',()=>continueCourse({offer:false,resumeReview:false})));return;}
  if(q.status!=='usable')addHTML(view,'<p>本题待核验。以下保留完整题设、共享说明和有适用条件的解答；暂不登记正常评分，也不进入复习排期。</p>','runtime-warning');
  if(q.contextHtml)addHTML(view,q.contextHtml,'exercise-context');
  addHTML(view,q.questionHtml,'exercise-question');
  if(q.answerHtml){const d=document.createElement('details');d.innerHTML='<summary>尝试后展开参考解</summary>';d.append(fragments(q.answerHtml));d.addEventListener('toggle',()=>{if(d.open)draft(id).answer=true;});view.append(d);}
  if(q.exampleHtml){const d=document.createElement('details');d.innerHTML='<summary>需要帮助时，查看相似示范 A</summary>';d.append(fragments(q.exampleHtml));d.addEventListener('toggle',()=>{if(d.open)draft(id).help=true;});view.append(d);}
  if(q.groupHtml){const d=document.createElement('details');d.innerHTML='<summary>查看完整题组及原文说明</summary>';d.append(fragments(q.groupHtml));
    d.querySelectorAll('details').forEach(n=>n.addEventListener('toggle',()=>{if(n.open){if(n.closest('[data-original-id]')?.dataset.originalId===id)draft(id).answer=true;else draft(id).help=true;}}));view.append(d);}
  const controls=document.createElement('div');controls.className='practice-controls';controls.dataset.questionId=id;view.append(controls);renderPracticeControls(controls,q,'direct');
  const a=actions(view);a.append(button('回看相关课件',()=>go({view:'lesson',moduleId:q.moduleId,mode:'browse',anchor:q.sourceAnchor||'',helpFor:q.id})),button('返回当前任务',()=>continueCourse({offer:false,resumeReview:false}),{name:'return-course'}),button('回到教材习题',()=>go({view:'exercises'})));
}
function renderReview() {
  const s=state.reviewSession;
  if(!s){view.innerHTML='<h1>讲练间隙</h1>';const queue=getReviewQueue(state,catalog,now());if(queue.ids.length)reviewOfferContents(view);else{addHTML(view,'<p>目前没有适用的到期项或首次巩固项，可以继续新课。</p>');actions(view).append(button('继续新课',continueCourse,{primary:true}));}return;}
  view.innerHTML=`<h1>关键点复习</h1><p class="runtime-meta">本组 ${s.ids.length} 项 · 已处理 ${s.index} 项。当前主线任务已保留；仅看小结不计成功回忆。</p>`;
  if(s.index>=s.ids.length) {
    addHTML(view,'<h2>本组小结</h2><p>下面是课件中预先准备的回顾；查看小结不会产生额外评分。</p>');
    for(const id of s.ids){const q=catalog.reviews.find(x=>x.id===id);if(q){const c=addHTML(view,`<h3>${esc(q.id)}</h3>`,'review-summary');addHTML(c,q.summaryHtml||'');addHTML(c,`<p class="runtime-small">下次：${esc(fmt(state.cards[id]?.card?.due))}</p>`);}}
    const savedPoint=s.returnPoint;
    const a=actions(view);a.append(button('返回当前任务',()=>commit({type:'finishReview'},()=>returnCourse(savedPoint)),{primary:true,name:'finish-review'}),button('撤销最近一次评分',()=>commit({type:'undo'},()=>renderReview()),{name:'undo-score'}));return;
  }
  const id=s.ids[s.index],q=catalog.reviews.find(x=>x.id===id);
  if(!q||q.status!=='usable'||state.enabledReviews[id]?.version!==q.version||(state.cards[id]&&state.cards[id].version!==q.version)){addHTML(view,'<p>本项内容目前不可用或版本已经变化，已暂停计分。已有记录仍保留，可结束本组后继续新课。</p>','runtime-warning');actions(view).append(button('结束本次显示并返回新课',()=>commit({type:'deferReview'},()=>returnCourse(s.returnPoint))));return;}
  addHTML(view,`<h2>${esc(q.id)}</h2><p>请先回忆，再查看答案，并按查看前是否独立想出来自评。</p>`);
  addHTML(view,q.questionHtml,'review-question');
  const d=document.createElement('details');d.id='review-answer';d.innerHTML='<summary>尝试后查看答案</summary>';d.append(fragments(q.answerHtml));view.append(d);
  const a=actions(view),token=uuid();
  const score=rating=>commit({type:'score',submissionId:token,questionId:id,mode:'review',rating,answerViewed:d.open,helpViewed:false},()=>{renderReview();renderStatus(`已保存；${id} 下次复习：${fmt(state.cards[id]?.card?.due)}`);});
  const again=button('没想起来',()=>score('again'),{disabled:true,name:'review-again'}),good=button('想起来了',()=>score('good'),{disabled:true,primary:true,name:'review-good'});
  d.addEventListener('toggle',()=>{again.disabled=good.disabled=!d.open;});
  a.append(again,good,button('暂回当前任务，保留本组',()=>returnCourse(s.returnPoint),{name:'pause-review'}));
  a.append(button('只看总结，不评分',()=>commit({type:'skipReview',questionId:id,reason:'summary'},()=>renderReview()),{name:'summary-only'}));
  a.append(button('稍后复习，返回当前任务',()=>commit({type:'deferReview'},()=>returnCourse(s.returnPoint)),{name:'defer-review'}));
  const previousSkip=s.skipped?.[s.index-1];
  if(previousSkip?.reason==='summary'){
    const prior=catalog.reviews.find(r=>r.id===previousSkip.questionId);
    addHTML(view,`<h2>刚才一项的简短小结（仅回看，未评分）</h2>${prior?.summaryHtml||''}`,'review-summary');
  }

  if(state.attempts.some(x=>!x.undoneAt))a.append(button('撤销最近一次评分',()=>commit({type:'undo'},()=>renderReview()),{name:'undo-score'}));
  addHTML(view,`<p class="runtime-small">此项${state.cards[id]?'已有复习记录':'是首次实际巩固'}。评分只更新这个 R 项，普通习题记录不会代替它的排期。</p>`);
}
function renderProgress() {
  const mods=catalog.modules.filter(m=>m.kind==='module'),usable=mods.filter(m=>m.status==='usable'),done=usable.filter(m=>state.modules[m.id]?.completedAt);
  view.innerHTML=`<h1>目录与进度</h1><p>当前可用微模块中，本轮已完成 <strong>${done.length} / ${usable.length}</strong>。另有 ${mods.filter(m=>m.status!=='usable').length} 个已编写待核模块；未生成章节仍待制作。</p><p class="runtime-small">制作状态与学习状态分别列出，不显示整体掌握率。</p>`;
  for(const section of sectionPlans(catalog)){
    const count=section.requiredExercises.filter(id=>confirmed(state,id)).length;
    const c=addHTML(view,`<h2>§${esc(section.number)} 本次安排</h2><p>${esc(section.scopeNote)}</p><p>必做原题确认：${count} / ${section.requiredExercises.length}。本轮完成不代表答对或掌握。</p><p>当前任务：${esc(taskTitle(task(),catalog))}。从目录继续学习时，会带回尚未完成的主线任务；已学内容始终可以回看。</p>`,'runtime-card');
    for(const id of section.requiredExercises){const q=question(id);addHTML(c,`<p class="runtime-small">原题 ${esc(q?.number)} · ${confirmed(state,id)?'已确认练习':'尚未确认'}</p>`);}
    for(const [id,d] of Object.entries(state.flow?.deferred||{}))if(d.sectionId===section.id)addHTML(c,`<p class="runtime-small">已暂缓（内容问题）：${esc(id)} · ${esc(fmt(d.at))}，未记为学过或做过。</p>`);
  }
  const list=document.createElement('ul');list.className='runtime-list';view.append(list);
  for(const m of catalog.modules){
    const prog=state.modules[m.id],li=document.createElement('li');
    li.innerHTML=`<strong>${esc(m.id)} · ${esc(m.title)}</strong><p class="runtime-small">制作：${m.status==='usable'?'可用':'待核验'}；个人：${prog?.completedAt?'已完成本轮':prog?.startedAt?'进行中':'未开始'}${m.kind==='check'?' · 阶段任务':''}</p>`;
    const a=actions(li);a.append(button('打开回看',()=>go({view:'lesson',moduleId:m.id,mode:'browse'})));
    if(m.status==='usable'&&!m.delayed)a.append(button('从这里继续学习',()=>continueCourse({offer:false,resumeReview:false})));
    list.append(li);
  }
  const settings=addHTML(view,`<h2>讲练间隙</h2><label>每完成 <input type="number" id="review-every" min="1" max="20" value="${state.settings.reviewEvery}"> 个讲练任务检查一次</label><br><label>每组最多 <input type="number" id="review-limit" min="1" max="10" value="${state.settings.reviewLimit}"> 项</label>`,'runtime-card');
  actions(settings).append(button('保存间隙设置',()=>commit({type:'settings',reviewEvery:Number(settings.querySelector('#review-every').value),reviewLimit:Number(settings.querySelector('#review-limit').value)})));
  const backups=addHTML(view,'<h2>备份与恢复</h2><p>备份包含继续位置、完成状态、作答日志、精选复习卡及设置。更换浏览器或清除网站数据前，请先导出。</p>','runtime-card');
  const a=actions(backups);a.append(button('导出备份',exportBackup,{name:'export-backup'}));
  const input=document.createElement('input');input.type='file';input.accept='.json,application/json';input.id='backup-file';input.setAttribute('aria-label','选择学习记录备份');backups.append(input);
  const importArea=document.createElement('div');backups.append(importArea);
  input.addEventListener('change',async()=>{
    importArea.replaceChildren();const file=input.files[0];if(!file)return;
    try {
      if(file.size>20*1024*1024)throw new Error('备份超过20MB，请先检查文件');
      const backup=JSON.parse(await file.text()),result=validateBackup(backup,catalog);
      const c=addHTML(importArea,`<h3>已校验，等待你确认替换</h3><p>此备份含 ${result.state.attempts.length} 条自评事件、${Object.keys(result.state.flow?.confirmations||{}).length} 道练习确认及 ${Object.keys(result.state.flow?.deferred||{}).length} 处内容暂缓。替换会覆盖当前浏览器的现有学习记录。</p><p>${esc((result.warnings||[]).join('；'))}</p>`,'runtime-confirm');
      const aa=actions(c);aa.append(button('先导出当前备份',exportBackup),button('确认替换当前学习记录',async()=>{
        if(busy)return;busy=true;renderStatus('正在恢复…');
        try{const r=await store.replace(backup);state=r.state;drafts.clear();busy=false;renderStatus('备份已恢复并保存');await go({view:'progress'});}
        catch(e){busy=false;showError(e);}
      },{name:'confirm-restore'}),button('取消',()=>{importArea.replaceChildren();input.value='';}));
    }catch(e){addHTML(importArea,`<p>备份无效，未修改现有记录：${esc(e.message)}</p>`,'runtime-error');}
  });
  if(navigator.storage?.persist)a.append(button('申请浏览器持久保存',async()=>{
    const ok=await navigator.storage.persist();addHTML(backups,`<p class="runtime-small">${ok?'浏览器已允许持久保存。':'浏览器未授予持久保存。'}仍建议定期导出备份。</p>`);
  }));
  if(state.attempts.some(x=>!x.undoneAt))actions(backups).append(button('撤销最近一次评分',()=>commit({type:'undo'},()=>renderProgress()),{name:'undo-score'}));
}
async function exportBackup() {
  try{
    const backup=await store.exportBackup(),text=JSON.stringify(backup,null,2),blob=new Blob([text],{type:'application/json'}),url=URL.createObjectURL(blob);
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
  state=await store.dispatch({type:'syncContent'});
  nav.className='runtime-nav';nav.replaceChildren();
  [['继续学习','home'],['教材习题','exercises'],['目录与进度','progress']].forEach(([label,v])=>{const b=button(label,()=>v==='home'?continueCourse():go({view:v}));b.dataset.view=v;nav.append(b);});
  if(testConfig){const n=document.createElement('div');n.className='runtime-test';n.textContent='测试数据环境：与正式学习记录隔离';sheet.prepend(n);window.__TOPOLOGY_APP__={store,catalog,get state(){return state;},go,refresh:async()=>{state=await store.read();await go({...route},{push:false});}};}
  const r=fromLocation();await go(r,{push:false,offer:r.view==='lesson'&&r.mode==='new'});
  store.subscribe(async()=>{
    if(busy)return;
    const fresh=await store.read();
    if(fresh.revision===state.revision)return;
    state=fresh;
    await go({...route},{push:false});
  });
  window.addEventListener('popstate',()=>go(fromLocation(),{push:false}));
  window.addEventListener('pageshow',ev=>{if(ev.persisted)view.querySelectorAll('details').forEach(d=>d.open=false);});
}
boot().catch(e=>{if(!errorBox){errorBox=document.createElement('div');errorBox.className='runtime-error';sheet.prepend(errorBox);}errorBox.hidden=false;errorBox.textContent=`学习功能启动失败：${e.message}。未改动学习记录；请重新启动或重试。`;});
