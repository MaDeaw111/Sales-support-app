import {semanticBadges} from './semantic-badge-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const start=html.indexOf('        function renderExecutiveDashboard(');
const source=html.slice(start,html.indexOf('\n        }',start)+10);
test('executive dashboard shows all three tiers and suppresses financial content for warehouse',()=>{
  const ctx=vm.createContext({ ...semanticBadges, escapeDashboardHtml:String,t:key=>key,renderDashboardAction:()=>'',renderDashboardHeader:(_title,_subtitle,actions)=>actions});
  vm.runInContext(source,ctx);
  const data={openCount:8,totalContract:50,actual:20,remaining:30,upcoming:{mt:15,small:1,large:0},activeContainers:2,queue:1,products:[{name:'Tapioca Pellet',contract:50,actual:20}],months:[{month:'2026-11',actual:20,planned:50}],watchlist:[{ref:'WCAT014',product:'Tapioca Pellet',planned:15,actual:0,amount:2785,currency:'EUR',poId:'PO1',alert:'upcomingLoading'}],contractValue:{EUR:5000},receivables:{USD:1000},overdue:1};
  const output=ctx.renderExecutiveDashboard(data,'EXPORT','');
  for(const value of ['50 MT','EUR 5,000.00','USD 1,000.00','WCAT014','Tapioca Pellet','2026-11','executive.watch']) assert.ok(output.includes(value),value);
  const warehouse=ctx.renderExecutiveDashboard(data,'PRODUCTION_WAREHOUSE','');
  assert.match(warehouse,/executive.queue/);
  assert.doesNotMatch(warehouse,/EUR|USD|executive.receivables/);
});

test('analytics render the donut, gauge, localized insight slides and four KPI jumps',()=>{
  const ctx=vm.createContext({ ...semanticBadges, state:{executiveInsight:1},getUiLanguage:()=> 'TH',escapeDashboardHtml:String,t:key=>key,renderDashboardAction:()=>'',renderDashboardHeader:(_title,_subtitle,actions)=>actions});
  vm.runInContext(source,ctx);
  const output=ctx.renderExecutiveDashboard({period:'this_month',totalContract:50,products:[{name:'Tapioca',contract:50}],upcoming:{},months:[],watchlist:[],receivables:{},onPlanRatePct:75,onPlanCount:3,loadedCount:4,insights:[{th:'First slide'},{th:'Selected Thai slide'},{th:'Third slide'}]},'EXPORT','');
  assert.match(output,/data-product-mix[\s\S]*conic-gradient/);
  assert.match(output,/data-on-plan-gauge[\s\S]*75%/);
  assert.match(output,/Selected Thai slide/);
  assert.equal((output.match(/aria-pressed=/g)||[]).length,3);
  assert.equal((output.match(/>↗<\/button>/g)||[]).length,4);
  assert.match(output,/value="this_month" selected/);
  for(const view of ['po_engine','shipping','calendar','payments']) assert.ok(output.includes("changeView('"+view+"')"));
});

test('live admin response replaces loading placeholders with analytics and administration cards',()=>{
  const container={innerHTML:''};
  const data={role:'ADMIN',kpis:{active_users:7},health:[{label:'Data check',count:1,view:'customers'}],role_breakdown:[{role:'EXPORT',active_count:2,total_count:2}],executive:{openCount:1,totalContract:50,actual:0,remaining:50,upcoming:{},products:[{name:'Tapioca',contract:50}],gradeBreakdown:[{grade:'FEED_GRADE',sharePct:100,contract:50,actual:0,remaining:50}],months:[],watchlist:[]}};
  const ctx=vm.createContext({ ...semanticBadges, state:{currentUser:{role:'ADMIN'},dashboardSummary:{data:null,loading:true}},escapeDashboardHtml:String,t:key=>key,renderDashboardAction:label=>'<button>'+label+'</button>',renderDashboardHeader:(title,subtitle,actions)=>'<header>'+title+subtitle+actions+'</header>',renderDashboardCard:(label,value)=>label+' '+value,lucide:{createIcons(){}},console:{error(){}}});
  vm.runInContext(source,ctx);
  const start=html.indexOf('        function renderDashboard(container)');
  vm.runInContext(html.slice(start,html.indexOf('\n        }',start)+10),ctx);
  ctx.renderDashboard(container);
  assert.match(container.innerHTML,/dashboard.loading/);
  ctx.state.dashboardSummary={data,loading:false};
  ctx.renderDashboard(container);
  assert.match(container.innerHTML,/data-executive-dashboard/);
  assert.match(container.innerHTML,/dashboard.kpiActiveUsers 7/);
  assert.match(container.innerHTML,/Data check|EXPORT/);
  assert.equal((container.innerHTML.match(/<header>/g) || []).length,1);
  assert.match(container.innerHTML,/<header>executive.title[\s\S]*setExecutivePeriod[\s\S]*window.print\(\)[\s\S]*<\/header>/);
  for (const key of ['dashboard.addUser','dashboard.addCustomer','common.products','dashboard.addLogisticsPartner','common.refresh']) {
    assert.equal(container.innerHTML.split('<button>'+key+'</button>').length-1,1,key);
  }
  assert.doesNotMatch(container.innerHTML,/dashboard.adminTitle/);
  assert.doesNotMatch(container.innerHTML,/dashboard.loading/);
  data.executive.products=null;
  ctx.renderDashboard(container);
  assert.match(container.innerHTML,/dashboard.analyticsError/);
  assert.match(container.innerHTML,/dashboard.kpiActiveUsers 7/);
});
