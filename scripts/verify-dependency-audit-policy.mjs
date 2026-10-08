#!/usr/bin/env node
// Offline policy checks. Public npm package metadata only. No app/env/network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { evaluateAudit, exceptionPolicy, parseAuditProcess } from "./verify-dependency-audit.mjs";
const lock=JSON.parse(readFileSync(new URL("../package-lock.json",import.meta.url),"utf8"));
const observed={
  "auditReportVersion": 2,
  "vulnerabilities": {
    "@next/eslint-plugin-next": {
      "name": "@next/eslint-plugin-next",
      "severity": "high",
      "isDirect": false,
      "via": [
        "fast-glob"
      ],
      "effects": [
        "eslint-config-next"
      ],
      "range": ">=14.3.0-canary.0",
      "nodes": [
        "node_modules/@next/eslint-plugin-next"
      ],
      "fixAvailable": {
        "name": "eslint-config-next",
        "version": "14.2.35",
        "isSemVerMajor": true
      }
    },
    "braces": {
      "name": "braces",
      "severity": "high",
      "isDirect": false,
      "via": [
        {
          "source": 1240992,
          "name": "braces",
          "dependency": "braces",
          "title": "braces vulnerable to stack-exhaustion denial of service through deeply nested patterns",
          "url": "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
          "severity": "high",
          "cwe": [
            "CWE-674"
          ],
          "cvss": {
            "score": 7.5,
            "vectorString": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H"
          },
          "range": "<=3.0.3"
        }
      ],
      "effects": [
        "micromatch"
      ],
      "range": "*",
      "nodes": [
        "node_modules/braces"
      ],
      "fixAvailable": {
        "name": "patch-package",
        "version": "6.0.7",
        "isSemVerMajor": true
      }
    },
    "eslint-config-next": {
      "name": "eslint-config-next",
      "severity": "high",
      "isDirect": true,
      "via": [
        "@next/eslint-plugin-next"
      ],
      "effects": [],
      "range": ">=14.3.0-canary.0",
      "nodes": [
        "node_modules/eslint-config-next"
      ],
      "fixAvailable": {
        "name": "eslint-config-next",
        "version": "14.2.35",
        "isSemVerMajor": true
      }
    },
    "fast-glob": {
      "name": "fast-glob",
      "severity": "high",
      "isDirect": false,
      "via": [
        "micromatch"
      ],
      "effects": [
        "@next/eslint-plugin-next"
      ],
      "range": "*",
      "nodes": [
        "node_modules/fast-glob"
      ],
      "fixAvailable": {
        "name": "eslint-config-next",
        "version": "14.2.35",
        "isSemVerMajor": true
      }
    },
    "find-yarn-workspace-root": {
      "name": "find-yarn-workspace-root",
      "severity": "high",
      "isDirect": false,
      "via": [
        "micromatch"
      ],
      "effects": [
        "patch-package"
      ],
      "range": "*",
      "nodes": [
        "node_modules/find-yarn-workspace-root"
      ],
      "fixAvailable": {
        "name": "patch-package",
        "version": "6.0.7",
        "isSemVerMajor": true
      }
    },
    "micromatch": {
      "name": "micromatch",
      "severity": "high",
      "isDirect": false,
      "via": [
        "braces"
      ],
      "effects": [
        "fast-glob",
        "find-yarn-workspace-root"
      ],
      "range": ">=0.2.0",
      "nodes": [
        "node_modules/micromatch"
      ],
      "fixAvailable": {
        "name": "patch-package",
        "version": "6.0.7",
        "isSemVerMajor": true
      }
    },
    "patch-package": {
      "name": "patch-package",
      "severity": "high",
      "isDirect": true,
      "via": [
        "find-yarn-workspace-root"
      ],
      "effects": [],
      "range": ">=6.1.0-0",
      "nodes": [
        "node_modules/patch-package"
      ],
      "fixAvailable": {
        "name": "patch-package",
        "version": "6.0.7",
        "isSemVerMajor": true
      }
    }
  },
  "metadata": {
    "vulnerabilities": {
      "info": 0,
      "low": 0,
      "moderate": 0,
      "high": 7,
      "critical": 0,
      "total": 7
    }
  }
};
const clone=value=>structuredClone(value);
const now="2026-10-03T04:41:36.058Z";
let checks=0;
const pass=callback=>{callback();checks++;};
const reject=callback=>pass(()=>assert.throws(callback,/AUDIT_/));
const classify=(report=clone(observed), packages=clone(lock), time=now, status=report.metadata.vulnerabilities.high+report.metadata.vulnerabilities.critical>0?1:0)=>evaluateAudit(report,packages,{now:time,status});
function recount(report){
 const counts={info:0,low:0,moderate:0,high:0,critical:0,total:0};
 for(const value of Object.values(report.vulnerabilities)){if(value.severity in counts)counts[value.severity]++;counts.total++;}
 report.metadata.vulnerabilities=counts;
 return report;
}
function mutated(change, sync=true){const report=clone(observed),packages=clone(lock);change(report,packages);if(sync)recount(report);reject(()=>classify(report,packages));}
pass(()=>assert.equal(classify().waivedHighPackageEntries,7));
pass(()=>assert.equal(classify().rawCounts.high,7));
pass(()=>assert.equal(classify().expiresAt,exceptionPolicy.expiresAt));
pass(()=>assert.equal(classify().blockingHighOrCritical,0));
// A production Next advisory must never inherit the development-only braces exception.
for(const severity of ["high","critical"]){
 mutated(r=>{r.vulnerabilities.next={name:"next",severity,isDirect:true,nodes:["node_modules/next"],via:[{source:1241496,name:"next",dependency:"next",severity,range:">=16.0.0 <16.3.8",url:"https://github.com/advisories/GHSA-cjq9-62q9-8jv4"}]};});
}
// Matching lint updates retain the reviewed dependency edges and reject old installs.
for(const name of ["eslint-config-next","@next/eslint-plugin-next"]){
 mutated((r,l)=>{l.packages["node_modules/"+name].version="16.3.6";});
}
const empty={auditReportVersion:2,vulnerabilities:{},metadata:{vulnerabilities:{info:0,low:0,moderate:0,high:0,critical:0,total:0}}};
pass(()=>assert.equal(classify(empty,lock,now,0).exceptionUsed,false));
pass(()=>assert.equal(classify(empty,lock,exceptionPolicy.expiresAt,0).exceptionUsed,false));
for(const severity of ["info","low","moderate"]){
 pass(()=>{const report=clone(empty),packages=clone(lock);report.vulnerabilities["public-test"]=clone(observed.vulnerabilities.braces);const item=report.vulnerabilities["public-test"];item.name="public-test";item.nodes=["node_modules/public-test"];item.severity=severity;Object.assign(item.via[0],{name:"public-test",dependency:"public-test",severity,source:1,url:"https://github.com/advisories/GHSA-aaaa-bbbb-cccc"});packages.packages["node_modules/public-test"]={version:"1.0.0",dev:true};recount(report);assert.equal(classify(report,packages,now,0).exceptionUsed,false);});
}
for(const severity of ["high","critical"]){
 mutated((r,l)=>{r.vulnerabilities["public-test"]=clone(r.vulnerabilities.braces);const f=r.vulnerabilities["public-test"];f.name="public-test";f.nodes=["node_modules/public-test"];f.severity=severity;Object.assign(f.via[0],{name:"public-test",dependency:"public-test",severity,source:2,url:"https://github.com/advisories/GHSA-aaaa-bbbb-cccc"});l.packages["node_modules/public-test"]={version:"1.0.0",dev:true};});
}
mutated(r=>{r.vulnerabilities.braces.via.push({...r.vulnerabilities.braces.via[0],source:2,url:"https://github.com/advisories/GHSA-aaaa-bbbb-cccc"});});
mutated(r=>{r.vulnerabilities.micromatch.via.push({...r.vulnerabilities.braces.via[0],name:"micromatch",dependency:"micromatch",source:2,url:"https://github.com/advisories/GHSA-aaaa-bbbb-cccc"});});
mutated(r=>{r.vulnerabilities.micromatch.via.push("fast-glob");});
mutated(r=>{r.vulnerabilities.braces.severity="critical";r.vulnerabilities.braces.via[0].severity="critical";});
for(const url of [exceptionPolicy.advisory+"/","https://github.com/advisories/GHSA-vfj7-8cjw-p6xm-extra","https://github.com.evil.example/advisories/GHSA-vfj7-8cjw-p6xm","http://github.com/advisories/GHSA-vfj7-8cjw-p6xm"]){mutated(r=>{r.vulnerabilities.braces.via[0].url=url;});}
for(const [key,value] of [["source",1],["name","micromatch"],["dependency","micromatch"],["range","*"],["severity","moderate"]]){mutated(r=>{r.vulnerabilities.braces.via[0][key]=value;});}
mutated(r=>{r.vulnerabilities.braces.via[0].source="1240992";});
for(const via of [[],[null],[false],["missing"],[{}]]){mutated(r=>{r.vulnerabilities.micromatch.via=via;});}
mutated(r=>{r.vulnerabilities.braces.via=["micromatch"];});
for(const nodes of [[],["../node_modules/braces"],["node_modules/x/../braces"],["node_modules/braces","node_modules/braces"],["node_modules/missing/node_modules/braces"],["node_modules/braces\\"]]){mutated(r=>{r.vulnerabilities.braces.nodes=nodes;});}
mutated((r,l)=>{l.packages["node_modules/other/node_modules/braces"]=clone(l.packages["node_modules/braces"]);});
mutated((r,l)=>{l.packages["node_modules/braces"].dev=false;});
mutated((r,l)=>{delete l.packages["node_modules/braces"].dev;});
mutated((r,l)=>{l.packages["node_modules/braces"].link=true;});
mutated((r,l)=>{l.packages["node_modules/braces"].name="alias";});
mutated((r,l)=>{l.packages["node_modules/braces"].version="3.0.4";});
mutated((r,l)=>{l.packages["node_modules/fast-glob"].version="3.3.3";});
mutated((r,l)=>{delete l.packages["node_modules/micromatch"].dependencies.braces;});
mutated((r,l)=>{l.packages["node_modules/micromatch"].dependencies.braces="npm:alias@3.0.3";});
mutated((r,l)=>{delete l.packages["node_modules/braces"];});
mutated(r=>{r.vulnerabilities["patch-package"].isDirect=false;});
mutated(r=>{r.vulnerabilities.braces.name="wrong-name";});
mutated(r=>{r.vulnerabilities.braces.severity="unknown";});
mutated(r=>{r.auditReportVersion=1;});
mutated(r=>{r.error={code:"PUBLIC_TEST_ERROR"};});
mutated(r=>{r.vulnerabilities=[];},false);
mutated(r=>{r.vulnerabilities.braces=null;},false);
for(const value of [-1,"7",NaN,Infinity]){mutated(r=>{r.metadata.vulnerabilities.high=value;},false);}
mutated(r=>{r.metadata.vulnerabilities.total=8;},false);
mutated(r=>{delete r.metadata.vulnerabilities.moderate;},false);
mutated(r=>{r.metadata.vulnerabilities.unrecognized=0;},false);
reject(()=>classify(observed,lock,now,0));
reject(()=>classify(empty,lock,now,1));
mutated(r=>{for(const finding of Object.values(r.vulnerabilities))finding.severity="moderate";});
for(const severity of ["high","critical"]){
 mutated((r,l)=>{const f=clone(r.vulnerabilities.braces);Object.assign(f,{name:"public-test",nodes:["node_modules/public-test"],severity:"low"});Object.assign(f.via[0],{name:"public-test",dependency:"public-test",severity,source:2,url:"https://github.com/advisories/GHSA-aaaa-bbbb-cccc"});r.vulnerabilities["public-test"]=f;l.packages["node_modules/public-test"]={version:"1.0.0",dev:true};});
}
reject(()=>classify(observed,lock,"invalid date",1));
reject(()=>classify(observed,lock,"2026-10-02T23:59:59.999Z",1));
pass(()=>assert.equal(classify(observed,lock,"2026-11-01T23:59:59.999Z",1).exceptionUsed,true));
reject(()=>classify(observed,lock,exceptionPolicy.expiresAt,1));
reject(()=>classify(observed,lock,"2026-11-03T00:00:00.000Z",1));
const successfulProcess={status:1,signal:null,stdout:JSON.stringify(observed)};
pass(()=>assert.deepEqual(parseAuditProcess(successfulProcess),observed));
for(const modification of [{error:{code:"ETIMEDOUT"}},{error:{code:"ENOBUFS"}},{status:null,signal:"SIGTERM"},{status:2},{stdout:""},{stdout:"prefix "+JSON.stringify(observed)},{stdout:"{} trailing text"},{stdout:'{"truncated":'}]){reject(()=>parseAuditProcess({...successfulProcess,...modification}));}
const require=createRequire(import.meta.url);
const workflow=require("js-yaml").load(readFileSync(new URL("../.github/workflows/wrangler-config-guard.yml",import.meta.url),"utf8"));
const auditJob=workflow.jobs["dependency-audit"];
pass(()=>assert.deepEqual(auditJob.steps.filter(step=>step.run).map(step=>step.run),["npm ci","node scripts/verify-dependency-audit-policy.mjs","node scripts/verify-dependency-audit.mjs"]));
pass(()=>assert(auditJob.steps.every(step=>step["continue-on-error"]===undefined)));
pass(()=>assert.equal(auditJob.if,undefined));
console.log("ALPHA_AUDIT_POLICY_TESTS "+JSON.stringify({checks,observedHighPackageEntries:7,directApprovedAdvisories:1,network:false}));

