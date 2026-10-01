'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../backend/src');
function list(dir,files=[]){
  for(const item of fs.readdirSync(dir,{withFileTypes:true})){
    const full=path.join(dir,item.name);
    if(item.isDirectory())list(full,files);
    else if(item.isFile()&&item.name.endsWith('.ts')&&!item.name.endsWith('.d.ts'))files.push(full);
  }
  return files;
}
test('all backend production modules are reachable from the entry point',()=>{
  const files=list(root),seen=new Set(),queue=[path.join(root,'index.ts')];
  while(queue.length){
    const file=queue.pop();
    if(seen.has(file))continue;
    seen.add(file);
    const source=fs.readFileSync(file,'utf8');
    for(const match of source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]|\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)|\bimport\s*['"](\.[^'"]+)['"]/g)){
      const spec=match[1]||match[2]||match[3];
      let target=path.resolve(path.dirname(file),spec).replace(/\.js$/,'.ts');
      if(!fs.existsSync(target)&&fs.existsSync(path.join(target,'index.ts')))target=path.join(target,'index.ts');
      assert.ok(fs.existsSync(target),'broken relative import '+spec+' from '+path.relative(root,file));
      queue.push(target);
    }
  }
  assert.deepEqual(files.filter(file=>!seen.has(file)).map(file=>path.relative(root,file)),[],
    'delete or integrate unreachable backend module');
});
