import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
function load(ctx,name){
  const start=html.indexOf('        function '+name+'(');
  vm.runInContext(html.slice(start,html.indexOf('\n        }',start)+10),ctx);
}
test('CRM renders tier analytics, role-safe financial columns and Customer 360',()=>{
  const row={id:'C1',name:'Meelunie',tier:'S',tierSScore:1,petGradeMt:1000,feedGradeMt:0,totalContractedMt:1000,shippedMt:50,remainingMt:950,poCount:1,contractValue:{EUR:20000},ar:{EUR:300},overdue:true,orders:[{reference:'1606',mt:1000}],shipments:[{reference:'DI-01'}],invoices:[{reference:'WCAT014',currency:'EUR',balance:300}]};
  const model={owner:'U:ADMIN',filters:{tier:'S'},data:{summary:{...row,top1CustomerSharePct:100},reps:[],tiers:[{tier:'S',count:1,mt:1000,sharePct:100}],grades:[{grade:'PET_GRADE',mt:1000,sharePct:100}],rows:[row]}};
  let modal='';
  const ctx=vm.createContext({escapeDashboardHtml:value=>String(value??''),t:key=>key,state:{currentUser:{id:'U',role:'ADMIN'},crmAnalytics:model},openModal:value=>{modal=value;}});
  load(ctx,'renderCustomerAnalytics');
  load(ctx,'openCustomerAnalyticsDetail');
  const output=ctx.renderCustomerAnalytics(model,false,true);
  for(const text of ['data-crm-analytics','crm.concentration','crm.tier S','crm.PET_GRADE','EUR 20,000.00','crm.overdue','openEditCustomer']) assert.ok(output.includes(text),text);
  assert.doesNotMatch(ctx.renderCustomerAnalytics(model,true,false),/EUR|crm.payment|crm.ar/);
  ctx.openCustomerAnalyticsDetail('C1');
  assert.match(modal,/crm.detail[\s\S]*1,000 MT[\s\S]*1606[\s\S]*DI-01[\s\S]*WCAT014/);
});

test('CRM directory consolidates seven aligned columns with compact pills and amounts',()=>{
  const ctx=vm.createContext({escapeDashboardHtml:String,t:(key,params)=>params?.count!==undefined ? params.count+' PO' : ({'crm.petShort':'Pet','crm.feedShort':'Feed'}[key]||key)});
  load(ctx,'renderCustomerAnalytics');
  const row={id:'C1',name:'CCE HANSEATIC AGRI GMBH',code:'C-C-003',country:'USA',status:'ACTIVE_CUSTOMER',tier:'A',poCount:1,petGradeMt:3000,feedGradeMt:0,totalContractedMt:3000,remainingMt:3000,shippedMt:0,contractValue:{USD:1800000},ar:{},invoices:[]};
  const model={data:{summary:row,reps:[],tiers:[],grades:[],rows:[row]}};
  const output=ctx.renderCustomerAnalytics(model,false,true);
  const directory=output.slice(output.indexOf('<table class="crm-directory'));
  const headers=[...directory.matchAll(/<th scope="col"[^>]*>([^<]+)<\/th>/g)].map(match=>match[1]);
  assert.deepEqual(headers,['crm.customerTier','crm.rep','crm.ordersGrade','crm.remaining','crm.value','crm.statusPayment','crm.action']);
  assert.match(directory,/crm-customer-name[\s\S]*CCE HANSEATIC AGRI GMBH[\s\S]*crm-pill[^>]*>crm.tier A/);
  assert.match(directory,/crm-line">C-C-003 · USA/);
  assert.match(directory,/crm-line">Pet 3,000 · Feed 0 MT/);
  assert.match(directory,/crm-line">USD 1,800,000.00/);
  assert.match(directory,/crm-status-stack/);
  assert.match(html,/\.crm-pill \{[^}]*display: inline-flex;[^}]*white-space: nowrap;/);
  assert.match(html,/\.crm-directory th, \.crm-directory td \{ text-align: left; vertical-align: middle; padding: 12px 14px;/);
  const warehouse=ctx.renderCustomerAnalytics(model,true,false);
  assert.doesNotMatch(warehouse,/USD|crm.value|crm.statusPayment|crm.noInvoice/);
});
