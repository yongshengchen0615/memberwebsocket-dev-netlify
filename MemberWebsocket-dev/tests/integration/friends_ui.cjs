const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const path=require('node:path');

const source=fs.readFileSync(path.resolve(__dirname,'../../friends.js'),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,20));

test('same LINE identity switching business clears pending data and ignores the old business response',async()=>{
 const {dom,w,ready}=await page(false,'https://example.test/member/#friends');try{
  const current=w.MemberSystem.getSession();current.config.business='shop-a';ready();await tick();
  const field=w.document.getElementById('friendLookupCode');field.value='PRIVATE-A';
  let resolve;let first=true;w.MemberSystem.request=async()=>first?(first=false,new Promise(r=>resolve=r)):{friends:[{memberCode:'SHOP-B',displayName:'B○',status:'accepted'}],receivedBookings:[]};
  w.MemberFriends.clear();await tick();
  current.config.business='shop-b';ready();
  resolve({friends:[{memberCode:'PRIVATE-A',displayName:'A○',status:'accepted'}],receivedBookings:[]});await tick();await tick();
  assert.equal(field.value,'');assert.doesNotMatch(w.document.getElementById('friendList').textContent,/PRIVATE-A/);
  assert.match(w.document.getElementById('friendList').textContent,/SHOP-B/);
 }finally{dom.window.close();}
});

test('losing membership clears stored friend rows, lookup and share link immediately',async()=>{
 const {dom,w,ready}=await page(false,'https://example.test/member/#friends');try{
  w.document.getElementById('friendLookupCode').value='PRIVATE-A';
  ready({lineUserId:'verified-A',memberCode:'AAAA',profileComplete:false,membershipRequired:true});
  assert.equal(w.document.getElementById('friendList').textContent,'');
  assert.equal(w.document.getElementById('friendLookupCode').value,'');
  assert.equal(w.MemberFriends.invitationUrl(),'');
 }finally{dom.window.close();}
});

async function page(booking=false,url='https://example.test/member/#friend=BBBB000000'){
  const dom=new JSDOM(
    '<main id="'+(booking?'bookingView':'memberView')+'"><div id="memberPass"></div><p id="bookingNotice"></p><fieldset class="booking-contact-fieldset"><div id="bookingRecipientHost"></div></fieldset></main>',
    {pretendToBeVisual:true,runScripts:'outside-only',url}
  );
  const w=dom.window,calls=[];
  let friends=[{memberCode:'BBBB',displayName:'王○',status:'pending',incoming:true}];
  const session={config:{supabaseUrl:'https://example.test',supabasePublishableKey:'public'},idToken:'verified'};
  const request=async(_c,_t,_k,action,payload)=>{
    calls.push({action,payload});
    if(action==='member.referral.bind')return {rewardExpiresOn:'2026-12-31'};
    if(action.endsWith('list'))return {friends,receivedBookings:[]};
    if(action.endsWith('lookup'))return {memberCode:'CCCC',displayName:'陳○'};
    if(action.endsWith('accept'))friends=friends.map(f=>({...f,status:'accepted'}));
    return {status:'pending'};
  };
  w.MemberSystem={getSession:()=>session,request,formatDate:value=>value};
  if(booking){
    w.BookingSystem={getSession:()=>session};
    w.fetch=async(_url,opt)=>({
      ok:true,
      json:async()=>({
        ok:true,
        data:await request(null,null,null,JSON.parse(opt.body).action,JSON.parse(opt.body))
      })
    });
  }
  w.eval(fs.readFileSync(path.resolve(__dirname,'../../friend-qr-scanner.js'),'utf8'));
  if(!booking)w.eval(fs.readFileSync(path.resolve(__dirname,'../../member/member-growth.js'),'utf8'));
  w.eval(source);
  const ready=(profile={lineUserId:'verified-A',memberCode:'AAAA',inviteCode:'AAAA000000'})=>
    w.dispatchEvent(new w.CustomEvent(
      booking?'booking:member-loaded':'member-profile-ready',
      {detail:{profile}}
    ));
  ready();
  await tick();
  return {dom,w,calls,ready,setFriends:value=>friends=value};
}

test('friends tab keeps lookup and friend list; removed sharing sections do not affect reward entry',async()=>{
  const {dom,w,calls}=await page();
  try{
    assert.equal(w.document.getElementById('openMemberReferral').textContent,'邀請優惠');
    assert.equal(w.document.getElementById('memberFriendsModal').classList.contains('hidden'),false);
    assert.equal(w.document.getElementById('memberFriendsModal').querySelector('#memberReferralForm'),null);
    assert.equal(w.document.getElementById('memberReferralFriendsTabPanel').hidden,false);
    assert.equal(w.document.getElementById('memberReferralModal').classList.contains('hidden'),true);
    assert.equal(w.document.getElementById('friendLookupCode').value,'BBBB000000');
    assert.equal(w.document.getElementById('memberReferralInviteCode').value,'');
    assert.equal(w.document.getElementById('friendAddForm').closest('#memberReferralFriendsTabPanel')!==null,true);
    assert.equal(w.document.getElementById('friendInviteSection'),null);
    assert.equal(w.document.getElementById('memberReferralForm').closest('#memberReferralRewardTabPanel')!==null,true);
    assert.equal(w.document.getElementById('bindMemberReferral').disabled,true);
    assert.equal(w.document.getElementById('memberReferralQr'),null);
    assert.ok(w.document.getElementById('scanMemberReferralQr'));
    assert.ok(w.document.getElementById('uploadMemberReferralQr'));
    assert.ok(w.document.getElementById('memberReferralQrScanner'));

    w.document.getElementById('friendAddForm').dispatchEvent(new w.Event('submit',{cancelable:true}));
    await tick();
    assert.equal(calls.at(-1).action,'member.friend.lookup');
    assert.match(w.document.getElementById('friendStatus').textContent,/查找好友成功：陳○ · CCCC/);
    assert.equal(w.document.getElementById('friendStatus').dataset.state,'success');
    assert.equal(w.document.getElementById('confirmFriendRequest').hidden,false);
    assert.equal(w.document.getElementById('bindMemberReferral').disabled,true);
    assert.equal(calls.some(c=>c.action==='member.referral.bind'),false);

    w.document.getElementById('confirmFriendRequest').click();
    await tick();
    assert.equal(calls.some(c=>c.action==='member.friend.request'&&c.payload.memberCode==='CCCC'),true);
    assert.equal(calls.some(c=>c.action==='member.referral.bind'),false);

    [...w.document.querySelectorAll('#friendList button')].find(b=>b.textContent==='接受').click();
    await tick();
    assert.match(w.document.getElementById('friendList').textContent,/已成為好友/);
  }finally{dom.window.close();}
});

test('friend lookup failure is visible in the friends tab and never unlocks reward binding',async()=>{
  const {dom,w}=await page();
  try{
    const field=w.document.getElementById('friendLookupCode');
    field.value='AAAA';
    field.dispatchEvent(new w.Event('input',{bubbles:true}));
    await w.MemberFriends.lookup();
    assert.match(w.document.getElementById('friendStatus').textContent,/^查找好友失敗：不可使用自己的邀請碼或會員編號。$/);
    assert.equal(w.document.getElementById('friendStatus').dataset.state,'error');
    assert.equal(w.document.getElementById('confirmFriendRequest').hidden,true);
    assert.equal(w.document.getElementById('bindMemberReferral').disabled,true);

    w.MemberSystem.request=async(_c,_t,_k,action)=>{
      if(action.endsWith('lookup'))throw new Error('找不到符合的好友。');
      return {friends:[],receivedBookings:[]};
    };
    field.value='ZZZZ000000';
    field.dispatchEvent(new w.Event('input',{bubbles:true}));
    await w.MemberFriends.lookup();
    assert.match(w.document.getElementById('friendStatus').textContent,/^查找好友失敗：找不到符合的好友。$/);
    assert.equal(w.document.getElementById('confirmFriendRequest').hidden,true);
  }finally{dom.window.close();}
});

test('reward link opens only the reward workflow and binding does not create a friend request',async()=>{
  const {dom,w,calls}=await page(false,'https://example.test/member/#reward=CCCC');
  try{
    assert.equal(w.document.getElementById('memberReferralModal').classList.contains('hidden'),false);
    assert.equal(w.document.getElementById('memberReferralRewardTabPanel').hidden,false);
    assert.equal(w.document.getElementById('memberFriendsModal').classList.contains('hidden'),true);
    assert.equal(w.document.getElementById('memberReferralInviteCode').value,'CCCC');
    assert.equal(w.document.getElementById('friendLookupCode').value,'');
    assert.equal(w.document.getElementById('bindMemberReferral').disabled,false);
    assert.equal(w.document.getElementById('confirmFriendRequest').hidden,true);

    w.document.getElementById('memberReferralForm').dispatchEvent(new w.Event('submit',{cancelable:true}));
    await tick();
    assert.equal(calls.filter(c=>c.action==='member.referral.bind').length,1);
    assert.equal(calls.find(c=>c.action==='member.referral.bind').payload.memberCode,'CCCC');
    assert.equal(calls.some(c=>c.action==='member.friend.lookup'||c.action==='member.friend.request'),false);
    assert.match(w.document.getElementById('memberReferralStatus').textContent,/邀請成功！你已獲得 1 張好友優惠票券/);
  }finally{dom.window.close();}
});

test('friend and reward share links are purpose-specific and cannot silently cross-write',async()=>{
  const {dom,w,calls}=await page(false,'https://example.test/member/#friends');
  try{
    assert.match(w.MemberFriends.invitationUrl(),/#friend=AAAA$/);
    assert.match(w.MemberReferral.shareUrl(),/#reward=AAAA$/);

    let copied='';
    Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async text=>{copied=text;}},configurable:true});
    await w.MemberFriends.copyInvitationLink();
    assert.match(copied,/#friend=AAAA$/);
    await w.MemberReferral.copyLink();
    assert.match(copied,/#reward=AAAA$/);
    delete w.navigator.clipboard;
    w.document.execCommand=command=>{
      const field=w.document.querySelector('textarea.friend-copy-buffer');
      assert.equal(command,'copy');
      assert.ok(field?.closest('#memberFriendsModal'));
      assert.equal(field.closest('.hidden'),null,'Copy fallback must remain in the visible friends dialog');
      copied=field.value;
      return true;
    };
    await w.MemberFriends.copyInvitationLink();
    assert.match(copied,/#friend=AAAA$/);
    assert.match(w.document.getElementById('friendStatus').textContent,/已複製/);
    assert.equal(calls.some(c=>c.action==='member.friend.request'||c.action==='member.referral.bind'),false);
  }finally{dom.window.close();}
});

test('changing friend input invalidates only the pending friend request',async()=>{
  const {dom,w,calls}=await page();
  try{
    await w.MemberFriends.lookup();
    assert.equal(w.document.getElementById('confirmFriendRequest').hidden,false);
    const reward=w.document.getElementById('memberReferralInviteCode');
    reward.value='DDDD000000';
    reward.dispatchEvent(new w.Event('input',{bubbles:true}));
    assert.equal(w.document.getElementById('bindMemberReferral').disabled,false);
    assert.equal(w.document.getElementById('confirmFriendRequest').hidden,false);

    const friend=w.document.getElementById('friendLookupCode');
    friend.value='EEEE000000';
    friend.dispatchEvent(new w.Event('input',{bubbles:true}));
    assert.equal(w.document.getElementById('confirmFriendRequest').hidden,true);
    assert.equal(w.document.getElementById('bindMemberReferral').disabled,false);
    assert.equal(calls.some(c=>c.action==='member.referral.bind'),false);
  }finally{dom.window.close();}
});

test('booking lists only accepted friends and editing fixes the original recipient',async()=>{
  const {dom,w,setFriends,ready}=await page(true,'https://example.test/booking/');
  try{
    assert.equal(w.document.querySelector('#friendBookingRecipient').options.length,1);
    assert.equal(w.document.getElementById('friendBookingRecipient').closest('.booking-contact-fieldset')!==null,true);
    setFriends([{memberCode:'BBBB',displayName:'王○',status:'accepted'}]);
    ready();
    await tick();
    const select=w.document.getElementById('friendBookingRecipient');
    select.value='BBBB';
    select.dispatchEvent(new w.Event('change'));
    assert.equal(w.MemberFriends.selected(),'BBBB');
    w.MemberFriends.lock('BBBB','王○');
    await tick();
    assert.equal(select.disabled,true);
    assert.equal(select.value,'BBBB');
    w.MemberFriends.clear();
    await tick();
    assert.equal(select.disabled,false);
    assert.equal(w.MemberFriends.selected(),'');
  }finally{dom.window.close();}
});

test('late account A friend response cannot repaint account B',async()=>{
  const {dom,w}=await page(false,'https://example.test/member/#friends');
  try{
    let resolve,calls=0;
    w.MemberSystem.request=async(_c,_t,_k,action)=>{
      if(action==='member.referral.bind')return {};
      calls++;
      if(calls===1)return new Promise(r=>resolve=r);
      return {friends:[{memberCode:'BBBB',displayName:'B○',status:'accepted'}],receivedBookings:[]};
    };
    w.document.getElementById('refreshFriends').click();
    await tick();
    w.dispatchEvent(new w.CustomEvent('member-profile-ready',{detail:{profile:{lineUserId:'verified-B',memberCode:'BBBB',inviteCode:'BBBB000000'}}}));
    resolve({friends:[{memberCode:'PRIVATE-A',displayName:'A○',status:'accepted'}],receivedBookings:[]});
    await tick();
    await tick();
    assert.doesNotMatch(w.document.getElementById('friendList').textContent,/PRIVATE-A/);
    assert.match(w.document.getElementById('friendList').textContent,/BBBB/);
  }finally{dom.window.close();}
});

test('legacy invite link keeps referral semantics instead of becoming an add-friend action',async()=>{
  const {dom,w,calls}=await page(false,'https://example.test/member/#invite=BBBB000000');
  try{
    assert.equal(w.document.getElementById('memberReferralModal').classList.contains('hidden'),false);
    assert.equal(w.document.getElementById('friendLookupCode').value,'');
    assert.equal(w.document.getElementById('memberReferralInviteCode').value,'#invite=BBBB000000');
    w.document.getElementById('memberReferralForm').dispatchEvent(new w.Event('submit',{cancelable:true}));
    await tick();
    assert.equal(calls.filter(c=>c.action==='member.referral.bind').length,1);
    assert.equal(calls.find(c=>c.action==='member.referral.bind').payload.inviteCode,'BBBB000000');
    assert.equal(calls.some(c=>c.action==='member.friend.lookup'||c.action==='member.friend.request'),false);
  }finally{dom.window.close();}
});

test('switching accounts clears add-friend input and pending confirmation',async()=>{
  const {dom,w}=await page(false,'https://example.test/member/#friends');
  try{
    const friend=w.document.getElementById('friendLookupCode');
    friend.value='PRIVATE-A';
    friend.dispatchEvent(new w.Event('input',{bubbles:true}));
    await w.MemberFriends.lookup();
    w.dispatchEvent(new w.CustomEvent('member-profile-ready',{detail:{profile:{lineUserId:'verified-B',memberCode:'BBBB',inviteCode:'BBBB000000'}}}));
    await tick();
    assert.equal(friend.value,'');
    assert.equal(w.document.getElementById('confirmFriendRequest').hidden,true);
    assert.doesNotMatch(w.document.getElementById('friendStatus').textContent,/PRIVATE-A/);
  }finally{dom.window.close();}
});

test('friend and reward links cannot cross workflows',async()=>{
  const {dom,w,calls}=await page(false,'https://example.test/member/#friends');
  try{
    const friend=w.document.getElementById('friendLookupCode');
    friend.value='https://example.test/member/#reward=CCCC';
    friend.dispatchEvent(new w.Event('input',{bubbles:true}));
    await w.MemberFriends.lookup();
    assert.match(w.document.getElementById('friendStatus').textContent,/^查找好友失敗：/);
    assert.equal(w.document.getElementById('confirmFriendRequest').hidden,true);

    w.document.getElementById('openMemberReferral').click();
    const reward=w.document.getElementById('memberReferralInviteCode');
    reward.value='https://example.test/member/#friend=CCCC';
    reward.dispatchEvent(new w.Event('input',{bubbles:true}));
    w.document.getElementById('memberReferralForm').dispatchEvent(new w.Event('submit',{cancelable:true}));
    await tick();
    assert.match(w.document.getElementById('memberReferralStatus').textContent,/被邀請者會員編號/);
    assert.equal(w.document.getElementById('memberReferralStatus').classList.contains('error'),true);
    assert.equal(calls.some(c=>c.action==='member.friend.request'||c.action==='member.referral.bind'),false);
  }finally{dom.window.close();}
});
