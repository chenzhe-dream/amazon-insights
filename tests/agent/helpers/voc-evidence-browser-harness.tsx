import "../../../app/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { VocEvidenceDefinition } from "../../../app/voc-evidence-definition";
function Harness() {
 const [refresh, setRefresh] = useState(0), [enabled, setEnabled] = useState(true);
 const [project,setProject]=useState("10000000-0000-4000-8000-000000000002"), [session,setSession]=useState("fixture");
 return <><button onClick={() => setRefresh(x=>x+1)}>Edit manual</button><button onClick={()=>setEnabled(false)}>Logout</button><button onClick={()=>setEnabled(true)}>Resume</button>
 <button onClick={()=>setProject("10000000-0000-4000-8000-000000000004")}>Switch project</button><button onClick={()=>setSession("next-session")}>Switch session</button>
 <VocEvidenceDefinition key={`${project}:${session}`} projectId={project} baseSyncRunId="10000000-0000-4000-8000-000000000003" organizationId="10000000-0000-4000-8000-000000000001" sessionKey={session} marketplace={new URLSearchParams(location.search).get("marketplace") ?? "US"} asins={new URLSearchParams(location.search).get("catalogAsins")?.split(",") ?? ["B08L7DD8L9"]} products={[]} sources={{} as never} initialRunId={new URLSearchParams(location.search).get("vocRun")} initialHistoryRunId={new URLSearchParams(location.search).get("vocHistory")} initialSelectedAsins={new URLSearchParams(location.search).get("vocAsins")?.split(",")} onRunStarted={(id,asins,previousRunId)=>{const url=new URL(location.href);url.searchParams.set("vocRun",id);if(previousRunId)url.searchParams.set("vocHistory",previousRunId);url.searchParams.set("vocAsins",asins.join(","));history.replaceState(null,"",url);}} refreshToken={String(refresh)} enabled={enabled} /></>;
}
createRoot(document.getElementById("root")!).render(<Harness/>);
