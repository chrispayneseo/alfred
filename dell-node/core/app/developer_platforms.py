"""Account-level GitHub and Vercel adapters for Alfred Core.

Tokens stay in the Dell environment. Responses are bounded and sanitised before
entering Core. Mutation policy remains owned by Core, not these adapters.
"""

from __future__ import annotations
import httpx
from . import config

GITHUB_API = "https://api.github.com"
VERCEL_API = "https://api.vercel.com"
MAX_RESULTS = 100

def github_configured() -> bool:
    return bool(config.settings.github_token and config.settings.github_owner)

def vercel_configured() -> bool:
    return bool(config.settings.vercel_token)

def _limit(value: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1 or value > MAX_RESULTS:
        raise ValueError(f"limit must be between 1 and {MAX_RESULTS}")
    return value

def _gh_headers() -> dict:
    return {"Authorization": f"Bearer {config.settings.github_token}", "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28"}

def _vercel_params(extra: dict | None = None) -> dict:
    params = dict(extra or {})
    if config.settings.vercel_team_id:
        params["teamId"] = config.settings.vercel_team_id
    return params

async def github_list_repos(limit: int = 100) -> dict:
    if not github_configured(): raise RuntimeError("GitHub is not configured")
    size = _limit(limit)
    async with httpx.AsyncClient(timeout=config.settings.developer_platform_timeout_seconds) as client:
        r = await client.get(f"{GITHUB_API}/user/repos", headers=_gh_headers(),
            params={"per_page": size, "sort": "updated", "affiliation": "owner,collaborator,organization_member"})
        r.raise_for_status(); raw = r.json()
    repos = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict): continue
        repos.append({"name": str(item.get("name",""))[:200], "full_name": str(item.get("full_name",""))[:300],
          "private": bool(item.get("private")), "archived": bool(item.get("archived")),
          "default_branch": str(item.get("default_branch",""))[:200], "updated_at": str(item.get("updated_at",""))[:80],
          "html_url": str(item.get("html_url",""))[:1000]})
    return {"ok": True, "repos": repos}

async def github_get_repo(full_name: str) -> dict:
    if not github_configured(): raise RuntimeError("GitHub is not configured")
    if "/" not in full_name or len(full_name) > 300: raise ValueError("Invalid GitHub repository")
    async with httpx.AsyncClient(timeout=config.settings.developer_platform_timeout_seconds) as client:
        r=await client.get(f"{GITHUB_API}/repos/{full_name}",headers=_gh_headers()); r.raise_for_status(); item=r.json()
    return {"ok": True, "repo": {"name": str(item.get("name",""))[:200], "full_name": str(item.get("full_name",""))[:300],
      "private": bool(item.get("private")), "archived": bool(item.get("archived")),
      "default_branch": str(item.get("default_branch",""))[:200], "updated_at": str(item.get("updated_at",""))[:80],
      "open_issues_count": int(item.get("open_issues_count") or 0), "html_url": str(item.get("html_url",""))[:1000]}}

async def github_create_issue(full_name: str, title: str, body: str = "") -> dict:
    if not github_configured(): raise RuntimeError("GitHub is not configured")
    if "/" not in full_name or len(full_name)>300 or not title.strip(): raise ValueError("Invalid GitHub issue")
    async with httpx.AsyncClient(timeout=config.settings.developer_platform_timeout_seconds) as client:
        r=await client.post(f"{GITHUB_API}/repos/{full_name}/issues",headers=_gh_headers(),
          json={"title":title.strip()[:256],"body":body[:10000]}); r.raise_for_status(); item=r.json()
    return {"ok":True,"issue":{"number":int(item["number"]),"title":str(item.get("title",""))[:256],
      "state":str(item.get("state",""))[:40],"html_url":str(item.get("html_url",""))[:1000]}}

async def github_create_branch(full_name: str, branch: str, from_ref: str = "main") -> dict:
    if not github_configured(): raise RuntimeError("GitHub is not configured")
    if "/" not in full_name or not branch.strip() or not from_ref.strip(): raise ValueError("Invalid GitHub branch request")
    async with httpx.AsyncClient(timeout=config.settings.developer_platform_timeout_seconds) as client:
        base=await client.get(f"{GITHUB_API}/repos/{full_name}/git/ref/heads/{from_ref}",headers=_gh_headers()); base.raise_for_status()
        sha=base.json().get("object",{}).get("sha")
        if not sha: raise RuntimeError("GitHub base ref returned no SHA")
        r=await client.post(f"{GITHUB_API}/repos/{full_name}/git/refs",headers=_gh_headers(),
          json={"ref":f"refs/heads/{branch.strip()}","sha":sha}); r.raise_for_status()
    return {"ok":True,"repo":full_name,"branch":branch.strip(),"from_ref":from_ref.strip(),"sha":sha}

async def vercel_list_projects(limit: int = 100) -> dict:
    if not vercel_configured(): raise RuntimeError("Vercel is not configured")
    size=_limit(limit)
    headers={"Authorization":f"Bearer {config.settings.vercel_token}"}
    async with httpx.AsyncClient(timeout=config.settings.developer_platform_timeout_seconds) as client:
        r=await client.get(f"{VERCEL_API}/v9/projects",headers=headers,params=_vercel_params({"limit":size})); r.raise_for_status(); raw=r.json()
    projects=[]
    for item in raw.get("projects",[]) if isinstance(raw,dict) else []:
        if not isinstance(item,dict): continue
        projects.append({"id":str(item.get("id",""))[:200],"name":str(item.get("name",""))[:200],
          "framework":str(item.get("framework") or "")[:100],"updated_at":item.get("updatedAt")})
    return {"ok":True,"projects":projects}

async def vercel_list_deployments(project_id: str, limit: int = 20) -> dict:
    if not vercel_configured(): raise RuntimeError("Vercel is not configured")
    size=_limit(limit); headers={"Authorization":f"Bearer {config.settings.vercel_token}"}
    async with httpx.AsyncClient(timeout=config.settings.developer_platform_timeout_seconds) as client:
        r=await client.get(f"{VERCEL_API}/v6/deployments",headers=headers,
          params=_vercel_params({"projectId":project_id,"limit":size})); r.raise_for_status(); raw=r.json()
    deployments=[]
    for item in raw.get("deployments",[]) if isinstance(raw,dict) else []:
        if not isinstance(item,dict): continue
        deployments.append({"uid":str(item.get("uid",""))[:200],"name":str(item.get("name",""))[:200],
          "url":str(item.get("url",""))[:1000],"state":str(item.get("state",""))[:80],
          "created":item.get("created")})
    return {"ok":True,"deployments":deployments}

async def vercel_redeploy(deployment_id: str) -> dict:
    if not vercel_configured(): raise RuntimeError("Vercel is not configured")
    headers={"Authorization":f"Bearer {config.settings.vercel_token}","Content-Type":"application/json"}
    async with httpx.AsyncClient(timeout=config.settings.developer_platform_timeout_seconds) as client:
        r=await client.post(f"{VERCEL_API}/v13/deployments",headers=headers,
          params=_vercel_params(),json={"deploymentId":deployment_id,"name":"alfred-redeploy","target":"production"})
        r.raise_for_status(); item=r.json()
    return {"ok":True,"deployment":{"id":str(item.get("id",""))[:200],"url":str(item.get("url",""))[:1000],
      "ready_state":str(item.get("readyState",""))[:80]}}
