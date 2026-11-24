import {
    randomBytes,
    scrypt as scryptCallback,
    timingSafeEqual
} from "node:crypto";

import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export async function hashPassword(password) {
    const salt = randomBytes(16).toString("hex");

    const derived = await scrypt(password, salt, 64);

    return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password, storedHash) {
    if (
        typeof password !== "string" ||
        typeof storedHash !== "string"
    ) {
        return false;
    }

    const parts = storedHash.split(":");

    if (parts.length !== 2) return false;

    const [salt, expectedHex] = parts;

    if (
        !/^[a-f0-9]{32}$/i.test(salt) ||
        !/^[a-f0-9]{128}$/i.test(expectedHex)
    ) {
        return false;
    }

    const expected = Buffer.from(expectedHex, "hex");

    const actual = await scrypt(password, salt, 64);

    return timingSafeEqual(actual, expected);
}