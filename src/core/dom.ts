// JS snippets injected via Runtime.evaluate. All interaction is JS-dispatched
// (element.click(), native value setter + input/change events) rather than
// CDP Input.* — this works on BACKGROUND tabs, which native mouse events do
// not reliably reach in headed Chrome (devtools-protocol#89). Trade-off:
// dispatched events are not isTrusted, so a few hard anti-bot / payment flows
// may reject them; escalate those to a foregrounded native path if needed.
//
// Reads and ref-resolution PIERCE shadow DOM and descend into same-origin
// iframes, so text and clickable elements are found anywhere on the page —
// the way Playwright locators do. (Cross-origin iframes are separate CDP
// targets; address those directly with -t / -m on the iframe's URL.)
//
// Refs (e1, e2, …) are stamped onto the live DOM as `data-ba-ref` attributes.
// Each CLI invocation is a fresh process, so the ref table can't live in the
// CLI — it lives in the page. Re-snapshot after any DOM-changing action.

export interface SnapshotResult {
  url: string
  title: string
  count: number
  elements: Array<{ ref: string; role: string; tag: string; type: string; name: string }>
}

// Shared walker prelude: descends light DOM, open shadow roots, and same-origin
// iframes. Prepended to every expression that needs deep DOM access.
const WALK = `
function __baSkip(t){return t==='SCRIPT'||t==='STYLE'||t==='NOSCRIPT'||t==='TEMPLATE';}
function __baVisible(el){try{const s=getComputedStyle(el);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false;const r=el.getBoundingClientRect();return r.width>0||r.height>0;}catch(e){return true;}}
function __baEachEl(visit){
  function rec(node){
    if(node.nodeType!==1)return;
    const tag=node.tagName;
    if(__baSkip(tag))return;
    visit(node);
    if(node.shadowRoot){for(const c of node.shadowRoot.children)rec(c);}
    if(tag==='IFRAME'){try{const d=node.contentDocument;if(d&&d.body){for(const c of d.body.children)rec(c);}}catch(e){}return;}
    for(const c of node.children)rec(c);
  }
  if(document.body){for(const c of document.body.children)rec(c);}
}
function __baFind(ref){let f=null;__baEachEl((el)=>{if(!f&&el.getAttribute&&el.getAttribute('data-ba-ref')===ref)f=el;});return f;}
function __baQuery(sel){let f=null;__baEachEl((el)=>{if(!f){try{if(el.matches&&el.matches(sel))f=el;}catch(e){}}});return f;}
function __baText(root){
  let parts=[];
  function rec(node){
    if(node.nodeType===3){const t=node.textContent;if(t&&t.trim())parts.push(t.trim());return;}
    if(node.nodeType!==1)return;
    const el=node,tag=el.tagName;
    if(__baSkip(tag))return;
    try{const s=getComputedStyle(el);if(s.display==='none'||s.visibility==='hidden')return;}catch(e){}
    if(el.shadowRoot){for(const c of el.shadowRoot.childNodes)rec(c);}
    if(tag==='IFRAME'){try{const d=el.contentDocument;if(d&&d.body)rec(d.body);}catch(e){}return;}
    for(const c of el.childNodes)rec(c);
  }
  if(root)rec(root);
  return parts.join(' ').replace(/\\s+/g,' ').trim();
}
`

const INTERACTIVE = `'a,button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=menuitem],[role=switch],[onclick],[contenteditable=""],[contenteditable=true]'`

export const SNAPSHOT_EXPR = WALK + `(() => {
  __baEachEl((el)=>{ if(el.getAttribute && el.getAttribute('data-ba-ref')) el.removeAttribute('data-ba-ref'); });
  const isInteractive=(el)=>{try{return el.matches(${INTERACTIVE});}catch(e){return false;}};
  const out=[]; let i=1;
  __baEachEl((el)=>{
    if(!isInteractive(el)||!__baVisible(el))return;
    const ref='e'+(i++);
    el.setAttribute('data-ba-ref',ref);
    const tag=el.tagName.toLowerCase();
    const role=el.getAttribute('role')||tag;
    const type=el.getAttribute('type')||'';
    let name=(el.getAttribute('aria-label')||el.getAttribute('placeholder')||(el.value||'')||el.innerText||el.getAttribute('title')||el.getAttribute('name')||'').toString().trim().replace(/\\s+/g,' ').slice(0,80);
    out.push({ref,role,tag,type,name});
  });
  return {url:location.href,title:document.title,count:out.length,elements:out};
})()`

export function clickExpr(ref: string): string {
  const r = JSON.stringify(ref)
  return WALK + `(() => {
    const el=__baFind(${r});
    if(!el)return {err:'ref not found: '+${r}+' (re-run snapshot)'};
    el.scrollIntoView({block:'center',inline:'center'});
    el.click();
    return {ok:true,tag:el.tagName.toLowerCase()};
  })()`
}

export function fillExpr(ref: string, value: string, submit: boolean): string {
  const r = JSON.stringify(ref)
  const v = JSON.stringify(value)
  return WALK + `(() => {
    const el=__baFind(${r});
    if(!el)return {err:'ref not found: '+${r}+' (re-run snapshot)'};
    el.scrollIntoView({block:'center',inline:'center'});
    el.focus();
    if(el.isContentEditable){
      el.textContent=${v};
      el.dispatchEvent(new InputEvent('input',{bubbles:true}));
    } else {
      const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      const setter=Object.getOwnPropertyDescriptor(proto,'value')&&Object.getOwnPropertyDescriptor(proto,'value').set;
      if(setter)setter.call(el,${v});else el.value=${v};
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
    }
    if(${submit ? 'true' : 'false'}){
      const form=el.form||el.closest('form');
      if(form&&form.requestSubmit)form.requestSubmit();
      else if(form)form.submit();
      else{
        el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,bubbles:true}));
        el.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',keyCode:13,bubbles:true}));
      }
    }
    return {ok:true,value:el.value!==undefined?String(el.value).slice(0,80):${v}};
  })()`
}

export function readExpr(selector?: string): string {
  const root = selector ? `__baQuery(${JSON.stringify(selector)})` : `document.body`
  const notFound = selector ? `'(no element matches ' + ${JSON.stringify(selector)} + ')'` : `''`
  return WALK + `(() => { const r=${root}; return r ? __baText(r) : ${notFound}; })()`
}
