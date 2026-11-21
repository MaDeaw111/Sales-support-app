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
