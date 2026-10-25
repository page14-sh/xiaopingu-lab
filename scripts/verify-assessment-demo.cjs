const fs=require('node:fs/promises');
const path=require('node:path');
const {runAcceptance}=require('./fixtures/assessment-acceptance.cjs');
async function main(){
  if(process.argv.length!==2)throw new Error('This local-only runner accepts no environment, database or endpoint arguments.');
  // No environment variables or existing data files are read. Every run creates
  // a fresh isolated memory store; these exports are review artifacts, not imports.
  const {report,demo}=await runAcceptance();
  const directory=path.resolve(__dirname,'../outputs/t20');await fs.mkdir(directory,{recursive:true});
  for(const [name,data]of [['acceptance-report.json',report],['demo-summary.json',demo]]){
    const target=path.join(directory,name),temporary=target+'.tmp';await fs.writeFile(temporary,JSON.stringify(data,null,2)+'\n');await fs.rename(temporary,target);
  }
  console.log(JSON.stringify({status:'passed',checks:report.passed,events:demo.events.length,cycles:demo.cases.length,synthetic:true,external_calls:0,output_directory:directory}));
}
if(require.main===module)main().catch(error=>{console.error('T20 local acceptance failed:',error.message);process.exitCode=1;});
module.exports={main};
