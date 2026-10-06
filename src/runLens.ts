// The "Run in Terminal" CodeLens shown next to "Debug | Copy Invocation" on label / function / method signature lines.

import * as vscode from 'vscode';
import { findSignatures } from './methodRun';

export const RUN_LENS_SELECTOR: vscode.DocumentSelector = [
    { language: 'objectscript' },          // .mac
    { language: 'objectscript-int' },      // .int
    { language: 'objectscript-class' }     // .cls
];

export const RUN_LENS_ENABLED_KEY = 'iris-terminal.runLens.enabled';
const MAX_LINES = 50000;                   // a signature scan of a file this big is not worth it

export class RunLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this.changed.event;

    refresh() { this.changed.fire(); }

    provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
        if (!vscode.workspace.getConfiguration().get<boolean>(RUN_LENS_ENABLED_KEY, true)) return [];
        if (doc.lineCount > MAX_LINES) return [];
        const isClass = doc.languageId === 'objectscript-class';
        return findSignatures(doc.getText(), isClass).map(sig =>
            new vscode.CodeLens(new vscode.Range(sig.line, 0, sig.line, 0), {
                title: 'Run in Terminal',
                tooltip: 'Send a call to this to the IRIS terminal and run it (parameters are asked first)',
                command: 'iris-terminal.runMethod',
                arguments: [doc.uri, sig.line]
            }));
    }

    dispose() { this.changed.dispose(); }
}
