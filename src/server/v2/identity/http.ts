import { apiError, json, readBody, requireMutationOrigin } from "../../api";
import { requireIdentity } from "../../auth/access";
import { acceptLink, createKey, identitySettings, identityContext, inviteUser, listKeys, listUsers, manageLink, revokeKey, rotateKey, updateUser } from "./service";

type Context = {params:Promise<{id:string}>};
export async function identityHttp(request: Request, operation: "context"|"users"|"user"|"link"|"accept"|"keys"|"key"|"rotate"|"settings", context?: Context): Promise<Response> {
  try {
    if (request.method !== "GET") requireMutationOrigin(request);
    if (operation === "accept") return json(await acceptLink(await readBody(request)));
    const identity=await requireIdentity(request.headers);
    const id=context ? (await context.params).id : "";
    switch(operation) {
      case "context": return json(await identityContext(identity));
      case "settings": return json(await identitySettings(identity,await readBody(request)));
      case "users": return request.method === "GET" ? json(await listUsers(identity)) : json(await inviteUser(identity,await readBody(request)),201);
      case "user": return json(await updateUser(identity,id,await readBody(request)));
      case "link": return json(await manageLink(identity,id,request.method === "DELETE" ? null : await readBody(request)));
      case "keys": return request.method === "GET" ? json(await listKeys(identity)) : json(await createKey(identity,await readBody(request)),201);
      case "key": return json(await revokeKey(identity,id));
      case "rotate": return json(await rotateKey(identity,id,await readBody(request)),201);
    }
  } catch(error) { return apiError(error); }
}
