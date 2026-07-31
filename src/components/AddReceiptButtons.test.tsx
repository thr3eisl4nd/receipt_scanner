import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Person } from "../types";
import { AddReceiptButtons } from "./AddReceiptButtons";

const HUSBAND: Person = { id: "husband-id", name: "夫", colorIndex: 0 };
const WIFE: Person = { id: "wife-id", name: "妻", colorIndex: 1 };

function selectFile(input: HTMLInputElement, file: File) {
  fireEvent.change(input, { target: { files: [file] } });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * Codexレビュー v1.4指摘Minor2: 従来のテストはinput数とCTAのaria-labelしか検証しておらず、
 * 「主CTAをクリック→対象のhidden inputへchangeイベントが来る→onFilesが正しいpayerIdで
 * 呼ばれる」という実際の配線は素通りしていた。ここでは`HTMLInputElement.prototype.click`を
 * スパイし、CTAクリックが実際にどのhidden input要素を`.click()`したかを捕捉したうえで、
 * その要素へ直接changeイベントを発火して`onFiles`の呼び出し引数を検証する
 * (jsdomはファイル選択ダイアログを再現できないため、`.click()`された対象の同定と
 * changeイベント発火を分離して検証する)。
 */
describe("AddReceiptButtons", () => {
  it("夫が選択中の状態でカメラ/アルバムCTAをクリックすると、夫のhidden inputへ配線され、夫のpayerIdでonFilesが呼ばれる", () => {
    const onFiles = vi.fn();
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click");
    render(<AddReceiptButtons people={[HUSBAND, WIFE]} onFiles={onFiles} />);

    // 既定選択は先頭の人(夫)。カメラCTAをクリックすると、夫のcamera input(hidden)が
    // クリックされる。
    fireEvent.click(screen.getByRole("button", { name: "夫のレシートを撮る（カメラ）" }));
    expect(clickSpy).toHaveBeenCalledTimes(1);
    const clickedCameraInput = clickSpy.mock.instances[0] as HTMLInputElement;
    expect(clickedCameraInput.getAttribute("capture")).toBe("environment");

    const cameraFile = new File(["a"], "camera.png", { type: "image/png" });
    selectFile(clickedCameraInput, cameraFile);
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles).toHaveBeenCalledWith(HUSBAND.id, [cameraFile]);

    // アルバムCTAも同様に、夫のalbum input(hidden、capture属性なし)がクリックされる。
    fireEvent.click(screen.getByRole("button", { name: "夫のレシートをアルバムから選ぶ" }));
    expect(clickSpy).toHaveBeenCalledTimes(2);
    const clickedAlbumInput = clickSpy.mock.instances[1] as HTMLInputElement;
    expect(clickedAlbumInput.hasAttribute("capture")).toBe(false);
    expect(clickedAlbumInput).not.toBe(clickedCameraInput);

    const albumFile = new File(["b"], "album.png", { type: "image/png" });
    selectFile(clickedAlbumInput, albumFile);
    expect(onFiles).toHaveBeenCalledTimes(2);
    expect(onFiles).toHaveBeenLastCalledWith(HUSBAND.id, [albumFile]);
  });

  it("支払者セグメントで妻へ切り替えると、CTAは妻のhidden inputへ配線され、妻のpayerIdでonFilesが呼ばれる", () => {
    const onFiles = vi.fn();
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click");
    render(<AddReceiptButtons people={[HUSBAND, WIFE]} onFiles={onFiles} />);

    fireEvent.click(screen.getByRole("button", { name: "妻" }));

    fireEvent.click(screen.getByRole("button", { name: "妻のレシートを撮る（カメラ）" }));
    const clickedCameraInput = clickSpy.mock.instances[0] as HTMLInputElement;
    expect(clickedCameraInput.getAttribute("capture")).toBe("environment");
    const cameraFile = new File(["c"], "wife-camera.png", { type: "image/png" });
    selectFile(clickedCameraInput, cameraFile);
    expect(onFiles).toHaveBeenCalledWith(WIFE.id, [cameraFile]);

    fireEvent.click(screen.getByRole("button", { name: "妻のレシートをアルバムから選ぶ" }));
    const clickedAlbumInput = clickSpy.mock.instances[1] as HTMLInputElement;
    expect(clickedAlbumInput.hasAttribute("capture")).toBe(false);
    const albumFile = new File(["d"], "wife-album.png", { type: "image/png" });
    selectFile(clickedAlbumInput, albumFile);
    expect(onFiles).toHaveBeenLastCalledWith(WIFE.id, [albumFile]);

    // 夫のinputは一切クリックされていない(誤配線がないことの確認)。
    expect(clickSpy).toHaveBeenCalledTimes(2);
  });

  it("空のファイル選択(キャンセル)ではonFilesを呼ばない", () => {
    const onFiles = vi.fn();
    render(<AddReceiptButtons people={[HUSBAND]} onFiles={onFiles} />);

    fireEvent.click(screen.getByRole("button", { name: "夫のレシートを撮る（カメラ）" }));
    const input = document.querySelector('input[type="file"][capture="environment"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [] } });

    expect(onFiles).not.toHaveBeenCalled();
  });
});
