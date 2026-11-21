import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
test('External Sales analytics renders tiers, grades and own view without the leaderboard',()=>{
  const start=html.indexOf('        function renderExternalSalesAnalytics(');
  const ctx=vm.createContext({escapeDashboardHtml:String,t:key=>key});
  vm.runInContext(html.slice(start,html.indexOf('\n        }',start)+10),ctx);
  const amounts={paidShippedMt:20,unpaidShippedMt:15,remainingMt:35,earnedCommissionUsd:200,pendingCommissionUsd:180,forecastCommissionUsd:420};
  const model={filters:{period:'this_month'},data:{summary:{...amounts,contractedMt:70,contractValueByCurrency:{EUR:20000}},reps:[{...amounts,name:'Sira'}],grades:[{grade:'FEED_GRADE',contractedMt:20,shippedMt:20,sharePct:30},{grade:'PET_GRADE',contractedMt:50,shippedMt:15,sharePct:70}]}};
  const output=ctx.renderExternalSalesAnalytics(model,false);
  for(const token of ['data-sales-analytics','salesAnalytics.leaderboard','Sira','USD 200','USD 180','USD 420','FEED_GRADE','PET_GRADE','value="this_month" selected']) assert.ok(output.includes(token),token);
  assert.doesNotMatch(ctx.renderExternalSalesAnalytics(model,true),/salesAnalytics.leaderboard|Sira/);
});
