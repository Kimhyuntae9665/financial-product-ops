const enabled=value=>value==='true';
const httpsUrl=value=>{try{return new URL(value).protocol==='https:';}catch{return false;}};

// Credentials are accepted only from explicit runtime configuration. This module
// never reads .env, browser credentials, or user files.
export class OpsIntegrations {
  constructor(store,{env=process.env,fetchImpl=fetch}={}){
    this.store=store;this.fetch=fetchImpl;
    this.pending=new Map();
    this.jira={enabled:enabled(env.OPS_JIRA_ENABLED),base:env.OPS_JIRA_BASE_URL,project:env.OPS_JIRA_PROJECT,email:env.OPS_JIRA_EMAIL,token:env.OPS_JIRA_TOKEN};
    this.datadog={enabled:enabled(env.OPS_DATADOG_ENABLED),site:env.OPS_DATADOG_SITE||'datadoghq.com',key:env.OPS_DATADOG_API_KEY};
    this.jira.ready=this.jira.enabled&&httpsUrl(this.jira.base)&&!!this.jira.project&&!!this.jira.email&&!!this.jira.token;
    this.datadog.ready=this.datadog.enabled&&['datadoghq.com','datadoghq.eu','us3.datadoghq.com','us5.datadoghq.com','ap1.datadoghq.com','ap2.datadoghq.com'].includes(this.datadog.site)&&!!this.datadog.key;
  }
  status(){
    const persisted=id=>this.store.get('integrations',id);
    return [
      {id:'storage',name:'SQLite',mode:'local',detail:'로컬 파일 영속 저장 · PostgreSQL 클라우드 연결은 향후 구성 항목'},
      persisted('n8n')||{id:'n8n',name:'n8n',mode:'off',detail:'실제 workflow 이벤트 수신 전 · 워크플로 JSON 가져오기 필요'},
      {id:'gmail',name:'Gmail',mode:'off',detail:'메일 계정 미연결 · 인증 후 n8n 수신 경로 사용 가능'},
      {id:'drive',name:'Google Drive',mode:'off',detail:'Drive 계정 미연결 · 파일 업로드를 수행하지 않음'},
      this.adapterStatus('jira','Jira',this.jira),this.adapterStatus('datadog','Datadog',this.datadog)
    ];
  }
  adapterStatus(id,name,config){
    if(!config.enabled)return {id,name,mode:id==='jira'?'local':'off',detail:id==='jira'?'로컬 업무함 사용 · Jira 전송은 명시적 설정 후 활성화':'외부 지표 미전송 · 로컬 실측 지표만 표시'};
    if(!config.ready)return {id,name,mode:'failed',detail:'런타임 연동 설정이 불완전합니다. 자격 증명은 표시하지 않습니다.'};
    return this.store.get('integrations',id)||{id,name,mode:'configured',detail:'런타임 설정 완료 · 성공 응답 수신 전'};
  }
  async deliver(caseId,options={}){
    if(this.pending.has(caseId))return this.pending.get(caseId);
    const promise=this.deliverOnce(caseId,options);this.pending.set(caseId,promise);
    try{return await promise;}finally{this.pending.delete(caseId);}
  }
  async deliverOnce(caseId,{retry=false}={}){
    const item=this.store.requiredCase(caseId);const result={jira:'local',datadog:'off'};
    // Keep AI cases local even when a legacy intake/event route reaches this
    // shared adapter. Source provenance is fixed by the store, not the caller.
    if(item.sourceChannel==='llm')return result;
    const tickets=this.store.rows('tickets').filter(t=>t.caseId===caseId&&t.status==='open'&&!t.externalUrl&&(!retry||t.deliveryStatus==='failed'));
    if(this.jira.ready)for(const ticket of tickets){
      try{
        // Deliberately omit sourceText and candidate values from third-party data.
        const response=await this.fetch(`${this.jira.base.replace(/\/$/,'')}/rest/api/3/issue`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Basic ${Buffer.from(`${this.jira.email}:${this.jira.token}`).toString('base64')}`},body:JSON.stringify({fields:{project:{key:this.jira.project},issuetype:{name:'Task'},summary:'Synthetic product operations: review required',description:{type:'doc',version:1,content:[{type:'paragraph',content:[{type:'text',text:`Synthetic demo case ${caseId}. Review local application; no financial source data sent.`}]}]}}}),signal:AbortSignal.timeout(10000)});
        if(!response.ok)throw new Error('response');const data=await response.json();if(typeof data.key!=='string'||!/^[A-Z][A-Z0-9_]*-\d+$/.test(data.key))throw new Error('issue key');
        if(!this.store.get('cases',caseId))return {jira:'discarded',datadog:'discarded'};
        Object.assign(ticket,this.store.get('tickets',ticket.id));
        ticket.mode='jira';ticket.externalUrl=`${this.jira.base.replace(/\/$/,'')}/browse/${data.key}`;ticket.deliveryStatus='sent';delete ticket.lastError;this.store.put('tickets',ticket);this.success('jira','Jira');this.store.event(caseId,'jira-delivered','합성 검토 업무를 Jira에 생성했습니다.');result.jira='connected';
      }catch{if(!this.store.get('cases',caseId))return {jira:'discarded',datadog:'discarded'};Object.assign(ticket,this.store.get('tickets',ticket.id));ticket.deliveryStatus='failed';ticket.lastError='Jira 전송 실패';this.store.put('tickets',ticket);this.failure('jira','Jira',caseId);result.jira='failed';}
    }
    const previous=this.store.get('integrations','datadog');
    if(this.datadog.ready&&(!retry||previous?.mode==='failed')){
      try{const metrics=this.store.state().metrics;const response=await this.fetch(`https://api.${this.datadog.site}/api/v1/series`,{method:'POST',headers:{'Content-Type':'application/json','DD-API-KEY':this.datadog.key},body:JSON.stringify({series:['received','pending','applied','exceptions'].map(key=>({metric:`synthetic.product_ops.${key}`,type:'gauge',points:[[Math.floor(Date.now()/1000),metrics[key]]],tags:['environment:local-synthetic-demo']}))}),signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('response');if(!this.store.get('cases',caseId))return {jira:'discarded',datadog:'discarded'};this.success('datadog','Datadog');this.store.event(caseId,'metrics-delivered','합성 운영 건수 지표를 Datadog에 전송했습니다.');result.datadog='connected';}
      catch{if(!this.store.get('cases',caseId))return {jira:'discarded',datadog:'discarded'};this.failure('datadog','Datadog',caseId);this.store.ticket(item,'Datadog 지표 전송 실패: 상품 반영 상태는 변경하지 않았습니다.');result.datadog='failed';}
    }
    return result;
  }
  success(id,name){this.store.integration(id,{name,mode:'connected',detail:'명시적으로 활성화한 어댑터에서 성공 응답 수신',lastSuccessAt:this.store.at()});}
  failure(id,name,caseId){this.store.integration(id,{name,mode:'failed',detail:'외부 전송 실패 · 로컬 사건과 상품 상태 보존'});this.store.event(caseId,`${id}-failed`,`${name} 외부 전송 실패: 재시도 가능, 상품은 변경하지 않았습니다.`);}
  async retry(id){this.store.requiredCase(id);const failedJira=this.store.rows('tickets').some(t=>t.caseId===id&&t.deliveryStatus==='failed');const failedDatadog=this.store.rows('events').some(e=>e.caseId===id&&e.type==='datadog-failed')&&this.store.get('integrations','datadog')?.mode==='failed';if(!failedJira&&!failedDatadog){const error=new Error('실패한 외부 전송이 있는 사건만 재시도할 수 있습니다.');error.status=409;throw error;}const delivery=await this.deliver(id,{retry:true});return {case:this.store.requiredCase(id),delivery};}
}
