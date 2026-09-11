import "../../../app/voc-evidence-definition.css";
import "../../../app/globals.css";
import "../../../app/warm-theme.css";
import "../../../app/comparison-layout.css";
import {useState} from "react";
import {createRoot} from "react-dom/client";
import {LocalVocDefinition} from "../../../app/local-voc-definition";
const products=["B08Z36X6B4","B0BVFX154J","B01N6NL766"].map(asin=>({asin,brand:asin,title:"Shelf lamp",productFamily:"lighting" as const}));
const manual=Object.fromEntries(products.map(p=>[p.asin,{captureStatus:"dialog",attention:["【照明】100%"],positives:["【亮度】100%"],negatives:[],unmet:[],audiences:[],scenarios:[],motives:[]}])) as never;
function Harness(){const [saved,setSaved]=useState(false);const [enabled,setEnabled]=useState(true);return <><button onClick={()=>setSaved(true)}>Save fixture</button><button onClick={()=>setEnabled(false)}>Logout</button><LocalVocDefinition products={products} sources={{manualVocByAsin:saved?manual:{},keywordDemand:null}} enabled={enabled} projectId="10000000-0000-4000-8000-000000000002" baseSyncRunId="10000000-0000-4000-8000-000000000003" /></>}
createRoot(document.getElementById("root")!).render(<Harness/>);
