// Only installed by the allowlisted contract runner; close its own fixtures,
// never other Electron instances. A cancellation is not a test pass.
const owned = new Set();
let installed=false,closing=false;
export function ownContractFixture(close) {
  if(!process.env.WXAPP_CONTRACT_RUN) return ()=>{};
  owned.add(close);
  if(!installed) {
    installed=true;
    process.on("SIGTERM",async()=>{
      if(closing)return;closing=true;
      await Promise.allSettled([...owned].map(close=>close()));
      process.exit(143);
    });
  }
  return ()=>owned.delete(close);
}
