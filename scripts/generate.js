const fs = require("fs");

function splitHash(hash) {
    const bigHash = BigInt(hash);
    const hashOne = (bigHash >> BigInt(32)) & BigInt(0xffffffff);
    const hashTwo = bigHash & BigInt(0xffffffff);
    return {
        one: `0x${hashOne.toString(16).padStart(8, "0")}`,
        two: `0x${hashTwo.toString(16).padStart(8, "0")}`,
    };
}

function trimAndNormalize(str) {
    return str.trim().replace(/\/\*/g, " -- [[").replace(/\*\//g, "]] ");
}

function getNativeReturnType(type) {
    if (type == "string") return "_s";
    if (type == "char") return "_s";
    if (type == "float") return "_rf";
    if (type == "Vector3") return "_rv";
    if (type == "long") return "_rl";
    if (type == "int") return "_ri";
    if (type == "object") return "_ro";
    return "_ri"// default
}

const nativeParamTypes = {
    "int": "int",
    "Any": "int",
    "float": "float",
    "boolean": "boolean",
    "Vehicle": "int",
    "Cam": "int",
    "Vector3": "Vector3",
    "FireId": "int",
    "Pickup": "int",
    "string": "string",
    "Hash": "hash",
    "Ped": "int",
    "Entity": "int",
    "Object": "int",
    "Player": "int",
    "ScrHandle": "int",
    "Blip": "int",
    "Interior": "int",
}

function getParamType(param) {
    return nativeParamTypes[param.type] || param.type;
}

function getTypescriptType(argument) {
    const type = getParamType(argument);
    let tsType = "any";
    if (type == "string") return "string";
    if (type == "boolean") return "boolean";
    if (type == "int") return "number";
    if (type == "float") return "number";
    if (type == "Vector3") return "Vector3";
    if (type == "hash") return "number";
    return tsType;
}

function getTypescriptReturnType(type) {
    type = type.replace("[", "").replace("]", "");
    if (type == "void") return "void";
    return getTypescriptType({ type });
}

function getReturnWarpper(param) {
    const nativeType = getTypescriptType(param);
    let warpper = "";
    if (nativeType == "Vector3") warpper = "_mv";
    return warpper ? `${warpper}(${param.name})` : `${param.name} as ${nativeType}`;
}

class Native {
    hash;
    name;
    jhash;
    comment;
    params;
    results;
    rawNativeInfo;

    constructor(data) {
        this.rawNativeInfo = data;
        this.hash = data.hash;
        this.name = data.name;
        this.jhash = "Placeholder";
        this.comment = data.comment;

        // Convert params
        const params = [];
        for (const param of data.params) {
            params.push({
                name: param.name,
                type: getParamType(param),
                ref: param.ref,
            });
        }
        this.params = params;


        // Convert results
        const results = [];
        let splitedResults = data.results.split(", ");
        if (splitedResults.length <= 0) {
            results.push(getTypescriptReturnType(data.results));
        } else {
            for (const result of splitedResults) {
                results.push(getTypescriptReturnType(result));
            }
        }
        this.results = results;

    }

    getReferenceParams() {
        const params = [];
        for (const param of this.params) {
            if (param.ref) params.push(param);
        }
        return params;
    }

    isSinglePointer() {
        return this.getReferenceParams().length == 1;
    }

    getNativeName() {
        let name = this.name;
        const isUnderscore = name.startsWith("_");
        if (isUnderscore) {
            name = name.substring(1);
        }
        const parts = name.split("_");
        const firstPart = parts.shift().toLowerCase();
        const rest = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join("");
        return firstPart + rest;
    }

    getInvokeArgs() {
        const hashs = splitHash(this.hash);
        const args = [hashs.one, hashs.two];
        for (const param of this.params) {
            let acc = "";
            if (param.ref) {
                const singlePointer = this.isSinglePointer();
                if (param.type == "int") acc = singlePointer ? `_ii(${param.name})` : `_i`;
                if (param.type == "float") acc = singlePointer ? `_fi(${param.name})` : `_f`;
                if (param.type == "Vector3") acc = `_v`;
                acc = acc || "_i";
            } else {
                if (param.type == "func") acc = `_mfr(${param.name})`;
                if (param.type == "float") acc = `_fv(${param.name})`;
                if (param.type == "hash") acc = `_ch(${param.name})`;
                if (param.type == "object") acc = `...(_obj(${param.name})`;
                if (param.type == "string") acc = `_ts(${param.name})`;
                if (param.type == "char") acc = `_ts(${param.name})`;
                acc = acc || param.name;
            }

            args.push(acc);
        }

        if (this.results.length > 0 && this.results[0] != "void") {
            args.push("_r");
            if (this.results[0] != "boolean") {
                args.push(getNativeReturnType(this.results[0]));
            }
        }

        return args;
    }

    genDoc() {
        const desc = this.comment;

        if (desc.length <= 0) return "";
        let doc = "/**\n";

        const lines = desc.split("\n");
        lines.forEach((line) => {
            doc = doc.concat(` * ${trimAndNormalize(line)}\n`);
        });

        for (const param of this.params) {
            doc = doc.concat(` * @param ${param.name}\n`);
        }

        doc = doc.concat(" */\n");
        return doc;
    }

    genParams() {
        const params = []
        for (const param of this.params) {
            if (param.ref && !this.isSinglePointer()) continue;
            params.push(`${param.name}: ${getTypescriptType(param)}`);
        }
        return params.join(", ");
    }

    genReturnTypes() {
        const results = [...this.results];
        if (results.length <= 1) return results[0];
        results.shift();
        return `[${results.join(", ")}]`;
    }

    genReturn() {
        if (this.getReferenceParams().length <= 0) return "void";
    }

    genBody() {
        const invokeParams = this.getInvokeArgs().join(", ");
        if (this.getReferenceParams().length > 1) {
            const invokePart = `const [${this.getReferenceParams().map(p => p.name).join(", ")}] = _in(${invokeParams});`;
            const returnPart = `return [${this.getReferenceParams().map(p => getReturnWarpper(p)).join(", ")}]`;
            return `${invokePart}\n\t${returnPart}`;
        }
        return `return _in(${invokeParams})`;
    }

    generate() {
        return `\n${this.genDoc()}export function ${this.getNativeName()}(${this.genParams()}): ${this.genReturnTypes()} { \n\t${this.genBody()}; \n}\n`
    }

}

const debugNatives = [
    "0x3FEF770D40960D5A",
    "0xECB2FC7235A7D137",
    "0xEEF059FAD016D209",
    "0x2975C866E6713290",
    "0xA6E9C38DB51D7748",
    "0xBE8CD9BE829BBEBF",
    "0x7B3703D2D32DFA18",
]
const bDebug = false;
const template = fs.readFileSync("./src/header.ts", "utf8");

function generateNatives() {
    const path = "./bin/natives.json";
    if (!fs.existsSync(path)) throw new Error(`File ${path} not found`);
    const nativeDB = JSON.parse(fs.readFileSync(path, "utf8"));
    const allNatives = new Array();

    for (const [namespace, natives] of Object.entries(nativeDB)) {
        for (const [hash, native] of Object.entries(natives)) {
            native.hash = hash;
            native.namespace = namespace;
            allNatives.push(native);
        }
    }

    // Sort by name
    allNatives.sort((a, b) => {
        if (a.altName > b.altName) {
            return 1;
        } else {
            return -1;
        }
    });

    let output = template;
    allNatives.forEach((nativeInfo) => {
        if (bDebug && !debugNatives.includes(nativeInfo.hash)) return;
        const native = new Native(nativeInfo);
        output = output.concat(native.generate());
    });

    if (!fs.existsSync("./src")) {
        fs.mkdirSync("./src");
    }
    fs.writeFileSync("./src/natives.ts", output);

}

generateNatives();