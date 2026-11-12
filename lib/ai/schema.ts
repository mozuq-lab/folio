import type { AIRequest } from '../intelligence-types.ts';
import { ANALYZE_BATCH_SIZE } from './types.ts';

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
    case 'analyze':return object({kind:enumeration('analyze'),analysis:array(object({articleId:id,interest:integer(0,100),importance:integer(0,100),summary:string(1000,0),reason:string(500),importanceReason:string(500),tags:array(string(40),10)}),ANALYZE_BATCH_SIZE*2)});
    case 'preferences':return object({kind:enumeration('preferences'),profile:object({summary:string(1000),boostTerms:array(string(100),30),muteTerms:array(string(100),30),preferredDepth:enumeration('any','introductory','practical','advanced')})});
    case 'digest':return object({kind:enumeration('digest'),digest:object({title:string(200),overview:string(1500),items:array(object({articleId:id,summary:string(1500),takeaway:string(1000),minutes:integer(1,30)})),totalMinutes:integer(0,30),generatedAt:string(50),mode:enumeration('ai')})});
    case 'compare':return object({kind:enumeration('compare'),report:object({overview:string(2000),developments:array(object({text:string(1500),articleIds:ids})),perspectives:array(object({sourceName:string(1000),point:string(1500),articleIds:ids})),uncertainties:array(string(1000))})});
    case 'ask':return object({kind:enumeration('ask'),result:object({answer:string(6000),citations:array(object({articleId:id,quote:string(1000)}),30)})});
  }
}
// Apply the exact schema sent to the provider again at the trust boundary.
/**
 * schemaに合わない最初の場所と種類（例：`$.digest.items[0].summary too_long`）。合っていればnull。
 * ログに出すので、場所はschemaの項目名と配列の位置だけで作り、出力の値や未知の項目名は含めない。
 */
export function schemaMismatch(value:unknown,schema:Schema,path='$'):string|null {
  const at=(problem:string)=>`${path} ${problem}`;
  if(schema.type==='string'){
    if(typeof value!=='string')return at('not_string');
    if(schema.enum&&!schema.enum.includes(value))return at('not_in_enum');
    if(value.length<(schema.minLength??0))return at('too_short');
    return value.length>(schema.maxLength??Infinity)?at('too_long'):null;
  }
  if(schema.type==='integer'){
    if(typeof value!=='number'||!Number.isInteger(value))return at('not_integer');
    if(value<(schema.minimum??-Infinity))return at('below_minimum');
    return value>(schema.maximum??Infinity)?at('above_maximum'):null;
  }
  if(schema.type==='array'){
    if(!Array.isArray(value))return at('not_array');
    if(value.length<(schema.minItems??0))return at('too_few_items');
    if(value.length>(schema.maxItems??Infinity))return at('too_many_items');
    for(let i=0;i<value.length;i++){const found=schemaMismatch(value[i],schema.items!,`${path}[${i}]`);if(found)return found;}
    return null;
  }
  if(!value||typeof value!=='object'||Array.isArray(value))return at('not_object');
  const data=value as Record<string,unknown>;
  if(Object.keys(data).some(key=>!Object.hasOwn(schema.properties!,key)))return at('unexpected_key');
  for(const key of schema.required!){
    if(!Object.hasOwn(data,key))return `${path}.${key} missing`;
    const found=schemaMismatch(data[key],schema.properties![key],`${path}.${key}`);if(found)return found;
  }
  return null;
}
export function conforms(value:unknown,schema:Schema):boolean {
  return schemaMismatch(value,schema)===null;
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
