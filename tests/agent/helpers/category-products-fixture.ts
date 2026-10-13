/** Synthetic fixture adapter; production never converts category_report into category_products. */
export function categoryProductsFixture(raw:unknown,nodeId:unknown){
 const value=raw as any,container=value.data??value;
 return {data:(container.top100_products??[]).map((row:any,index:number)=>{
  const match=/(?:Category:\s*)?([^\n]+?)(?:,\s*|\s*\()Rank:\s*(\d+)/.exec(String(row.category_rank??''));
  return {...row,main_image:row.main_image?[row.main_image]:[],ratings:row.star_rating??null,rating_count:row.review_count??null,buybox_seller:row.seller??null,sub_category:[[container.category_stats_report?.category_name??match?.[1]?.trim()??'Floor Lamps',String(nodeId),Number(match?.[2]??(typeof row.category_rank==='number'?row.category_rank:index+1))]]};
 })};
}
