# boot() API v1.0

## Boot a container and mount files

* I boot a container
* I mount files "{ \"index.js\": { \"file\": { \"contents\": \"console.log('hello')\" } } }"
* The boot file "/home/web/index.js" exists

## Spawn npm install inside container

* I boot a container
* I mount files "{ \"package.json\": { \"file\": { \"contents\": \"{\\\"name\\\":\\\"test\\\"}\" } } }"
* I spawn "npm install" in the container
* The spawn exit code is "0"

## Dev server emits port discovery event

* I boot a container
* I mount files "{ \"server.js\": { \"file\": { \"contents\": \"import http from 'http'; const s = http.createServer((req,res)=>res.end('ok')); s.listen(3000);\" } } }"
* I listen for server-ready on the container
* I spawn "runtime run /server.js" in the container
* A server-ready event is received on port "3000"

## Export filesystem returns FileSystemTree

* I boot a container
* I mount files "{ \"a.txt\": { \"file\": { \"contents\": \"hello\" } }, \"dir\": { \"directory\": { \"b.txt\": { \"file\": { \"contents\": \"world\" } } } } }"
* I export the container filesystem
* The exported tree contains file "a.txt" with contents "hello"
* The exported tree contains directory "dir" with file "b.txt" with contents "world"

## Teardown and re-boot lifecycle

* I boot a container
* I teardown the container
* I boot a container again
* The container is a new instance
