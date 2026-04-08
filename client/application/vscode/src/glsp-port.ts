import * as net from 'node:net';

export const GLSP_PORT_ENV = 'BIGUML_GLSP_PORT';

let glspPortPromise: Promise<number> | undefined;

export function getGlspPort(): Promise<number> {
    if (!glspPortPromise) {
        glspPortPromise = findFreePort();
    }

    return glspPortPromise;
}

function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();

        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close(() => reject(new Error('Could not allocate a local GLSP port.')));
                return;
            }

            server.close(error => {
                if (error) {
                    reject(error);
                } else {
                    resolve(address.port);
                }
            });
        });
    });
}
