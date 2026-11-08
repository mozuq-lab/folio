import type { AIRequest } from '../intelligence-types.ts';

export type Schema = {type:'object'|'array'|'string'|'integer';properties?:Record<string,Schema>;required?:string[];additionalProperties?:false;items?:Schema;minItems?:number;maxItems?:number;maxLength?:number;minLength?:number;minimum?:number;maximum?:number;enum?:string[]};
const string=(maxLength=2000,minLength=1):Schema=>({type:'string',maxLength,minLength});
const enumeration=(...values:string[]):Schema=>({type:'string',enum:values});
const integer=(minimum:number,maximum:number):Schema=>({type:'integer',minimum,maximum});
const array=(items:Schema,maxItems=30,minItems=0):Schema=>({type:'array',items,minItems,maxItems});
const object=(properties:Record<string,Schema>):Schema=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const id=string(200);
const ids=array(id,30,1);
export function resultSchema(action:AIRequest['action']):Schema {
  switch(action){
    case 'analyze':return object({kind:enumeration('analyze'),analysis:array(object({articleId:id,interest:integer(0,100),importance:integer(0,100),summary:string(1000),reason:string(500),importanceReason:string(500)}))});
    case 'preferences':return object({kind:enumeration('preferences'),profile:object({summary:string(1000),boostTerms:array(string(100),30),muteTerms:array(string(100),30),preferredDepth:enumeration('any','introductory','practical','advanced')})});
    case 'digest':return object({kind:enumeration('digest'),digest:object({title:string(200),overview:string(1500),items:array(object({articleId:id,summary:string(1500),takeaway:string(1000),minutes:integer(1,30)})),totalMinutes:integer(0,30),generatedAt:string(50),mode:enumeration('ai')})});
    case 'compare':return object({kind:enumeration('compare'),report:object({overview:string(2000),developments:array(object({text:string(1500),articleIds:ids})),perspectives:array(object({sourceName:string(1000),point:string(1500),articleIds:ids})),uncertainties:array(string(1000))})});
    case 'ask':return object({kind:enumeration('ask'),result:object({answer:string(6000),citations:array(object({articleId:id,quote:string(1000)}),30)})});
  }
}
// Apply the exact schema sent to the provider again at the trust boundary.
export function conforms(value:unknown,schema:Schema):boolean {
  if(schema.type==='string') return typeof value==='string'&&(!schema.enum||schema.enum.includes(value))&&value.length>=(schema.minLength??0)&&value.length<=(schema.maxLength??Infinity);
  if(schema.type==='integer') return typeof value==='number'&&Number.isInteger(value)&&value>=(schema.minimum??-Infinity)&&value<=(schema.maximum??Infinity);
  if(schema.type==='array') return Array.isArray(value)&&value.length>=(schema.minItems??0)&&value.length<=(schema.maxItems??Infinity)&&value.every(item=>conforms(item,schema.items!));
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const data=value as Record<string,unknown>;
  return Object.keys(data).every(key=>Object.hasOwn(schema.properties!,key))&&schema.required!.every(key=>Object.hasOwn(data,key)&&conforms(data[key],schema.properties![key]));
}
// Claude structured outputs reject these keywords; conforms() still enforces them app-side.
const CLAUDE_UNSUPPORTED = ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems'] as const;
export function stripUnsupportedForClaude(schema: Schema): Schema {
  const copy = { ...schema } as Schema;
  for (const key of CLAUDE_UNSUPPORTED) delete copy[key];
  if (schema.items) copy.items = stripUnsupportedForClaude(schema.items);
  if (schema.properties) copy.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, stripUnsupportedForClaude(v)]));
  if (schema.required) copy.required = [...schema.required];
  if (schema.enum) copy.enum = [...schema.enum];
  return copy;
}
