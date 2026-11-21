import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
function load(ctx,name) {
  const start=html.indexOf('        function '+name+'(');
  assert.ok(start>=0,name);
  vm.runInContext(html.slice(start,html.indexOf('\n        }',start)+10),ctx);
}
test('calendar cards use invoice, DI and customer details with role-safe fallbacks',()=>{
  const ctx=vm.createContext({state:{currentUser:{role:'ADMIN'}},escapeCalendarHtml:String,calendarToneClasses:()=>''});
  load(ctx,'calendarEventDisplay');
  load(ctx,'renderCalendarEventChip');
  const event={event_id:'E',event_type:'LOADING_PLANNED',di_no:'1606-1',customer_po_no:'1606',customer_name:'CCE HANSEATIC AGRI GMBH',container_plan:"2 x 40'",planned_qty_mt:50,booking_no:'050650009',invoices:[{invoice_no:'WCAT014',invoice_type:'PRELIMINARY'}]};
  assert.match(ctx.renderCalendarEventChip(event),/WCAT014[\s\S]*DI 1606-1[\s\S]*CCE HANSEATIC AGRI GMBH - 2 x 40' · 50 MT · BK 050650009/);
  assert.equal(ctx.calendarEventDisplay({...event,invoices:[],di_no:'DI-1606-1'}).primary,'DI-1606-1');
  assert.equal(ctx.calendarEventDisplay({...event,invoices:[]}).secondary,'PO 1606');
  ctx.state.currentUser.role='PRODUCTION_WAREHOUSE';
  assert.doesNotMatch(ctx.renderCalendarEventChip(event),/WCAT014/);
});

test('invoice detail card shows status for authorized users and hides it for warehouse',()=>{
  let markup;
  const ctx=vm.createContext({state:{currentUser:{},operationsCalendar:{events:[{event_id:'E',event_type:'ETD',di_no:'1606-1',invoices:[{invoice_no:'WCAT014',invoice_type:'PRELIMINARY'}]}]}},CALENDAR_EVENT_TYPES:{},escapeCalendarHtml:String,calendarStatusBadge:()=>'',openModal:value=>{markup=value;}});
  load(ctx,'calendarEventDisplay');
  load(ctx,'calendarEventStatusValue');
  load(ctx,'openCalendarEventDetail');
  for(const role of ['ADMIN','MANAGER','EXPORT','SALES_SUPPORT','EXTERNAL_SALES']) {
    ctx.state.currentUser.role=role;
    ctx.openCalendarEventDetail('E');
    assert.match(markup,/data-calendar-invoice[\s\S]*WCAT014[\s\S]*PRELIMINARY/);
  }
  ctx.state.currentUser.role='PRODUCTION_WAREHOUSE';
  ctx.openCalendarEventDetail('E');
  assert.doesNotMatch(markup,/data-calendar-invoice|WCAT014/);
});
