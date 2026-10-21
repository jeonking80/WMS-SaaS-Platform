// Fresh HTTP connections let shared-port round robin sample both workers.
let ready=false;for(let i=0;i<6;i++){try{const response=await fetch('http://127.0.0.1:'+(process.env.PORT??3000)+'/api/ready',{headers:{connection:'close'},signal:AbortSignal.timeout(4000)});await response.arrayBuffer();if(response.ok){ready=true;break;}}catch{}}
process.exitCode=ready?0:1;
