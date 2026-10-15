import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { TranslationSource } from './market-theme-translation';

// Bump when prompt semantics, validation or glossary entries change.
export const THEME_TRANSLATION_POLICY = 'llm-glossary-memory/v1';
const terms = [
 ['Brightness','亮度','Helligkeit','Luminosité','Luminosità','Luminosidad','明るさ'],
 ['Ease of assembly','组装便捷性','Einfache Montage','Facilité de montage','Facilità di montaggio','Facilidad de montaje','組み立てやすさ'],
 ['Value for money','性价比','Preis-Leistungs-Verhältnis','Rapport qualité-prix','Rapporto qualità-prezzo','Relación calidad-precio','コストパフォーマンス'],
 ['Quality','质量','Qualität','Qualité','Qualità','Calidad','品質'],
 ['Durability','耐用性','Haltbarkeit','Durabilité','Durata','Durabilidad','耐久性'],
 ['Appearance','外观','Aussehen','Apparence','Aspetto','Apariencia','外観'],
 ['Size','尺寸','Größe','Taille','Dimensioni','Tamaño','サイズ'],
 ['Color','颜色','Farbe','Couleur','Colore','Color','色'],
 ['Remote control','遥控器','Fernbedienung','Télécommande','Telecomando','Control remoto','リモコン'],
 ['Stability','稳定性','Stabilität','Stabilité','Stabilità','Estabilidad','安定性'],
] as const;
const targetColumn = {'en-US':0,'en-GB':0,'en-CA':0,'zh-CN':1,'de-DE':2,'fr-FR':3,'it-IT':4,'es-ES':5,'ja-JP':6} as const;

/** Exact, registered topic names only. Never replace words within customer prose. */
export function fixedThemeTranslation(source: TranslationSource): string | null {
 if (!['group-label','member-keyword'].includes(source.item.field)) return null;
 const original = source.item.original.trim().normalize('NFC').toLowerCase();
 const row = terms.find(values => values.some(value => value.normalize('NFC').toLowerCase() === original));
 return row?.[targetColumn[source.language]] ?? null;
}

const recordSchema = z.object({version:z.literal(THEME_TRANSLATION_POLICY),key:z.string(),original:z.string(),translated:z.string().min(1).max(20000)}).strict();

/** Successful exact-text translations, independent of report IDs; authorization remains in the caller. */
export class MarketThemeTranslationMemory {
 constructor(private readonly root:string, private readonly modelIdentity:string) {}
 key(source:TranslationSource) {
  const purpose=['group-label','member-keyword'].includes(source.item.field)?'label':'prose';
  return createHash('sha256').update(JSON.stringify([THEME_TRANSLATION_POLICY,this.modelIdentity,source.organizationId,source.language,purpose,source.item.original])).digest('hex');
 }
 read(source:TranslationSource):string|null {
  const key=this.key(source);
  try {
   const entry=recordSchema.parse(JSON.parse(readFileSync(join(this.root,'content',key+'.json'),'utf8')));
   return entry.key===key&&entry.original===source.item.original?entry.translated:null;
  } catch { return null; }
 }
 save(source:TranslationSource,translated:string) {
  const key=this.key(source),directory=join(this.root,'content');
  const entry=recordSchema.parse({version:THEME_TRANSLATION_POLICY,key,original:source.item.original,translated});
  mkdirSync(directory,{recursive:true});
  const target=join(directory,key+'.json'),temp=target+'.'+randomUUID()+'.tmp';
  writeFileSync(temp,JSON.stringify(entry),'utf8');renameSync(temp,target);
 }
}
