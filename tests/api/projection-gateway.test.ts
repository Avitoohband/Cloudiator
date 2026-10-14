import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
const holder = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock('../../src/lib/api/client', () => ({ getBrowserClient: () => holder.client }));
import { createLiveGateway } from '../../src/lib/api/gateway';
afterEach(() => { holder.client = null; });
describe('live projection session guards', () => {
  it.each([{state:{gladiatorId:'private-first'}},null])('rejects a delayed owner success/no-character response from the previous account: %j', async response => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    let session = { user: { id: 'first' }, access_token: 'first-token' } as Session;
    const client = createClient('http://127.0.0.1:54321', 'test-key', { auth: {persistSession:false}, global:{fetch:async()=>{
      await wait;return new Response(JSON.stringify(response),{headers:{'Content-Type':'application/json'}});
    }}});
    vi.spyOn(client.auth,'getSession').mockImplementation(async()=>({data:{session},error:null}));holder.client=client;
    const gateway=createLiveGateway(), pending=gateway.owner();
    await new Promise(resolve=>setTimeout(resolve,0));
    session={user:{id:'second'},access_token:'second-token'} as Session;release();
    await expect(pending).rejects.toMatchObject({code:'unauthenticated'});
  });
  it('uses protected server authorization for expiry and never substitutes fixtures on a denied read', async () => {
    const client=createClient('http://127.0.0.1:54321','test-key',{auth:{persistSession:false},global:{fetch:async()=>new Response(
      JSON.stringify({code:'PGRST303',message:'expired'}),{status:401,headers:{'Content-Type':'application/json'}})}});
    vi.spyOn(client.auth,'getSession').mockResolvedValue({data:{session:{user:{id:'first'},access_token:'expired'} as Session},error:null});holder.client=client;
    await expect(createLiveGateway().world()).rejects.toMatchObject({code:'unauthenticated'});
  });
  it('invalidates on account changes but keeps the cache through same-account focus and token refresh', () => {
    const client=createClient('http://127.0.0.1:54321','test-key',{auth:{persistSession:false}});holder.client=client;
    let callback!: Parameters<typeof client.auth.onAuthStateChange>[0];const unsubscribe=vi.fn();
    vi.spyOn(client.auth,'onAuthStateChange').mockImplementation(handler=>{callback=handler;return {data:{subscription:{id:'test',callback:handler,unsubscribe}}};});
    const changed=vi.fn(), remove=createLiveGateway().subscribeSession!(changed);
    const session={user:{id:'first'},access_token:'first'} as Session;
    callback('INITIAL_SESSION',session);callback('SIGNED_IN',session);callback('TOKEN_REFRESHED',{...session,access_token:'refreshed'});
    expect(changed).not.toHaveBeenCalled();
    callback('SIGNED_IN',{...session,user:{id:'second'} as Session['user']});expect(changed).toHaveBeenCalledTimes(1);
    callback('SIGNED_OUT',null);expect(changed).toHaveBeenCalledTimes(2);remove();expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
