export interface ConfigJSON {
    linkFolder: string;
    watch?: string | string[]
    commitTriggers?: string | string[];
    ignore?: string | string[];
    outputFolder: string;
}

export interface Config {
    linkFolder: string;
    watch: string[];
    commitTriggers: string[];
    ignore: string[];
    outputFolder: string;
}

