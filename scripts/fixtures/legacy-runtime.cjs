const vm=require('node:vm'),fs=require('node:fs');
function fixture(file,initial={},env={}){
 const rows=structuredClone(initial),writes=[];
 const command={in:v=>({$in:v}),neq:v=>({$ne:v}),or:v=>({$or:v}),set:v=>v};
 function matches(row,filter){return Object.entries(filter||{}).every(([key,value])=>key==='$or'?value.some(v=>matches(row,v)):value&&typeof value==='object'&&'$in'in value?value.$in.includes(row[key]):value&&typeof value==='object'&&'$ne'in value?row[key]!==value.$ne:row[key]===value);}
 const db={command,collection(name){rows[name]??=[];let filter={},limit=Infinity;const q={where(f){filter=f;return q;},limit(n){limit=n;return q;},orderBy(){return q;},async get(){return {data:structuredClone(rows[name].filter(r=>matches(r,filter)).slice(0,limit))};},async add(data){const record={_id:'synthetic-'+rows[name].length,...structuredClone(data)};rows[name].push(record);writes.push({name,op:'add'});return {id:record._id};},async update(data){for(const row of rows[name].filter(r=>matches(r,filter)))Object.assign(row,structuredClone(data));writes.push({name,op:'update'});return {updated:1};},doc(id){filter={_id:id};return {...q,async remove(){rows[name]=rows[name].filter(r=>r._id!==id);writes.push({name,op:'remove'});return {deleted:1};}};}};return q;}};
 const module={exports:{}};
 const code=fs.readFileSync(file,'utf8');
 vm.runInNewContext(code,{module,exports:module.exports,require:n=>n==='@cloudbase/node-sdk'?{init:()=>({database:()=>db})}:require(n),process:{env},Buffer,URL,URLSearchParams,console,fetch:()=>{throw new Error('External network forbidden in synthetic test');}}, {filename:file});
 async function request(url,{method='GET',body,token,headers={}}={}){let result;await module.exports.handleRequest({method,url,headers:{...headers,...(token?{authorization:'Bearer '+token}:{})},__bodyRaw:body===undefined?'':JSON.stringify(body)},{writeHead(status){result={status};},end(text){try{result.body=JSON.parse(text);}catch{result.body=text;} }});return result;}
 return {rows,writes,request};
}
module.exports={fixture};
