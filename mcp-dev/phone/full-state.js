import { openingLedger } from '../opening-ledger.js';

const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const finance = state => openingLedger(state).ledger;
export function initialFull(defaults) {
  const ledger=defaults();
  return {format:1,ledger,base:finance(ledger),revision:null,dirty:false,flight:null,conflict:null,lastSync:null};
}
export function editFull(book,next) {
  const ledger=structuredClone(next);
  // Even a legacy field that needs review must remain usable and exportable offline.
  let dirty=true;
  try { dirty=!equal(finance(ledger),book.base); } catch {}
  return {...book,ledger,dirty};
}
const adopt = (book,ledger) => ({...ledger,ui:book.ledger.ui});
export async function exchangeFull({read,persist,pull,post}) {
  for (let pass=0; pass<5; pass++) {
    let book=read();
    if (book.conflict || book.bulkReview) return;
    if (book.flight) {
      const flight=book.flight;
      const res=await post(flight);
      book=read();
      if (res.error==='revision_conflict') {
        const remote=await pull(null);
        if (!remote.ledger) throw Error('无法取得云端版本。');
        persist({...read(),flight:null,conflict:remote}); return;
      }
      if (res.error || res.receipt_revision!==flight.expected_revision+1) throw Error('云端未接收本次修改，已保留本机版本。');
      const next={...book,base:flight.ledger,revision:res.receipt_revision,flight:null,lastSync:Date.now()};
      persist(editFull(next,book.ledger));
      continue;
    }
    const remote=await pull(book.revision);
    if (remote.error || !Number.isSafeInteger(remote.revision)) throw Error('测试账本尚未就绪。');
    book=read();
    if (book.bulkReview) return;
    if (remote.ledger) {
      const different=!equal(book.base,remote.ledger);
      if (book.dirty && different) { persist({...book,conflict:remote}); return; }
      book={...book,base:remote.ledger,ledger:book.dirty?book.ledger:adopt(book,remote.ledger),revision:remote.revision};
    }
    if (!book.dirty) { persist({...book,lastSync:Date.now()}); return; }
    let draft;
    try {draft=finance(book.ledger);} catch {throw Error('本机数据需要核对，待同步内容仍保存在本机。');}
    persist({...book,flight:{operation_id:crypto.randomUUID(),expected_revision:book.revision,ledger:draft}});
  }
}
export function resolveFull(book,useLocal) {
  const remote=book.conflict;
  if (!remote) return book;
  const prior=useLocal?remote.ledger:finance(book.ledger);
  const next={...book,revision:remote.revision,base:remote.ledger,flight:null,conflict:null,
    recovery:{at:Date.now(),ledger:prior}};
  return editFull(next,useLocal?book.ledger:adopt(book,remote.ledger));
}
