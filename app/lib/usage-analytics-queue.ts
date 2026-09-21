import {USAGE_MAX_AGE_MS,type UsageEvent} from "../../shared/usage-analytics-contracts";
type Stored={key:string;owner:string;event:UsageEvent};
export class UsageQueue{
  private memory=new Map<string,Stored>();
  private db:Promise<IDBDatabase|null>|null=null;
  constructor(private owner:string){}
  private open(){
    return this.db??=new Promise<IDBDatabase|null>(resolve=>{
      if(typeof indexedDB==="undefined"){resolve(null);return}
      try{const request=indexedDB.open("amazon-insights-usage-v1",1);
        request.onupgradeneeded=()=>{const db=request.result;const events=db.createObjectStore("events",{keyPath:"key"});events.createIndex("owner","owner");db.createObjectStore("meta",{keyPath:"key"})};
        request.onsuccess=()=>resolve(request.result);request.onerror=()=>resolve(null);request.onblocked=()=>resolve(null);
      }catch{resolve(null)}
    });
  }
  async append(events:UsageEvent[]){
    if(!events.length)return;
    const records=events.map(event=>({key:this.owner+":"+event.eventId,owner:this.owner,event}));
    records.forEach(r=>this.memory.set(r.key,r));
    const db=await this.open();if(!db)return;
    await new Promise<void>(resolve=>{try{const tx=db.transaction("events","readwrite");records.forEach(r=>tx.objectStore("events").put(r));tx.oncomplete=()=>{records.forEach(r=>this.memory.delete(r.key));resolve()};tx.onerror=()=>resolve();tx.onabort=()=>resolve()}catch{resolve()}});
  }
  async read(now=Date.now(),limit=180):Promise<UsageEvent[]>{
    const db=await this.open();let records:Stored[]=[];
    if(db)records=await new Promise<Stored[]>(resolve=>{try{const request=db.transaction("events").objectStore("events").index("owner").getAll(this.owner);request.onsuccess=()=>resolve(request.result);request.onerror=()=>resolve([])}catch{resolve([])}});
    const all=new Map([...records,...this.memory.values()].map(r=>[r.key,r]));
    const expired:string[]=[];const valid:UsageEvent[]=[];
    for(const {event} of all.values()){const at=Date.parse(event.kind==="duration"?event.startedAt:event.at);if(at<now-USAGE_MAX_AGE_MS)expired.push(event.eventId);else valid.push(event)}
    if(expired.length)await this.ack(expired);
    return valid.sort((a,b)=>Date.parse(a.kind==="duration"?a.startedAt:a.at)-Date.parse(b.kind==="duration"?b.startedAt:b.at)).slice(0,limit);
  }
  async ack(ids:string[]){
    ids.forEach(id=>this.memory.delete(this.owner+":"+id));const db=await this.open();if(!db)return;
    await new Promise<void>(resolve=>{try{const tx=db.transaction("events","readwrite");ids.forEach(id=>tx.objectStore("events").delete(this.owner+":"+id));tx.oncomplete=()=>resolve();tx.onerror=()=>resolve();tx.onabort=()=>resolve()}catch{resolve()}});
  }
  // A short IndexedDB transaction coordinates sends even on LAN HTTP where Web Locks is unavailable.
  async claim(now:number,minimumGap:number):Promise<boolean>{
    const db=await this.open();if(!db)return true;
    return new Promise<boolean>(resolve=>{
      try{const tx=db.transaction("meta","readwrite"),store=tx.objectStore("meta"),key=this.owner+":last-send",req=store.get(key);let won=false;
        req.onsuccess=()=>{if(!req.result||now-req.result.at>=minimumGap){won=true;store.put({key,at:now})}};
        tx.oncomplete=()=>resolve(won);tx.onerror=()=>resolve(false);tx.onabort=()=>resolve(false);
      }catch{resolve(false)}
    });
  }
}
