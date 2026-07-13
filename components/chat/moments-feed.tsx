"use client";

import { useState, useEffect, useCallback, useLayoutEffect, useRef } from "react";
import { getAllPosts, deleteMomentPost, getUnreadMomentsNotifications, saveMomentsLastSeen, addMomentComment } from "@/lib/moments-storage";
import { loadChatContacts } from "@/lib/chat-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { saveChatImageToIndexedDB, getChatImageFromIndexedDB } from "@/lib/chat-asset-storage";
import type { MomentComment, MomentPost } from "@/lib/moments-types";
import { MomentPostCard } from "./moment-post-card";
import { MomentsCompose } from "./moments-compose";
import { ConfirmDialog } from "@/components/ui/modal";
import { PageShell } from "@/components/ui/page-shell";
import { AlertCircle } from "lucide-react";
import { kvGet, kvSet, registerKvMigration } from "@/lib/kv-db";
import { onUserComment } from "@/lib/moments-engine";

const COVER_ASSET_KEY = "moments_cover_asset_id";
registerKvMigration(COVER_ASSET_KEY);
registerKvMigration("moments_signature");

const MOMENTS_INITIAL_POST_COUNT = 10;
const MOMENTS_LOAD_MORE_COUNT = 10;

type MomentScrollAnchorSnapshot = {
    postId: string;
    offsetDelta: number;
};

type ActiveMomentComposer = {
    postId: string;
    replyTo?: {
        commentId: string;
        authorId: string;
        authorType: "user" | "character" | "npc";
        name: string;
    };
};

type MomentsFeedProps = {
    onCloseApp: () => void;
};

export function MomentsFeed({ onCloseApp }: MomentsFeedProps) {
    const [posts, setPosts] = useState<MomentPost[]>([]);
    const [showCompose, setShowCompose] = useState(false);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [coverUrl, setCoverUrl] = useState<string | null>(null);
    const coverInputRef = useRef<HTMLInputElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const userIdentity = resolveUserIdentity(undefined, "chat");
    const [signature, setSignature] = useState(() => {
        if (typeof window !== "undefined") {
            return kvGet("moments_signature") || "make every day count (●ˇ∀ˇ●)";
        }
        return "make every day count (●ˇ∀ˇ●)";
    });
    const [editingSignature, setEditingSignature] = useState(false);
    const sigInputRef = useRef<HTMLInputElement>(null);
    const handleSignatureSubmit = (val: string) => {
        const trimmed = val.trim() || "make every day count (●ˇ∀ˇ●)";
        setSignature(trimmed);
        kvSet("moments_signature", trimmed);
        setEditingSignature(false);
    };

    const [unreadNotifs, setUnreadNotifs] = useState<ReturnType<typeof getUnreadMomentsNotifications>>([]);
    const [showNotifModal, setShowNotifModal] = useState(false);
    const [headerScrolled, setHeaderScrolled] = useState(false);
    const [visiblePostCount, setVisiblePostCount] = useState(MOMENTS_INITIAL_POST_COUNT);
    const [activeComposer, setActiveComposer] = useState<ActiveMomentComposer | null>(null);
    const [composerText, setComposerText] = useState("");
    const composerInputRef = useRef<HTMLTextAreaElement>(null);
    const loadMoreRestoreRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
    const loadMoreAnchorRef = useRef<MomentScrollAnchorSnapshot | null>(null);
    const loadMoreResizeObserverRef = useRef<ResizeObserver | null>(null);
    const loadMoreAnchorTimerRef = useRef<number | null>(null);

    const getScrollElement = useCallback(() => {
        if (scrollRef.current) return scrollRef.current;
        if (typeof document === "undefined") return null;
        const el = document.querySelector<HTMLDivElement>(".moments-feed-page .page-body");
        if (el) scrollRef.current = el;
        return el;
    }, []);

    const stopLoadMoreAnchorTracking = useCallback(() => {
        loadMoreResizeObserverRef.current?.disconnect();
        loadMoreResizeObserverRef.current = null;
        if (loadMoreAnchorTimerRef.current !== null) {
            window.clearTimeout(loadMoreAnchorTimerRef.current);
            loadMoreAnchorTimerRef.current = null;
        }
        loadMoreAnchorRef.current = null;
    }, []);

    useEffect(() => stopLoadMoreAnchorTracking, [stopLoadMoreAnchorTracking]);

    const refreshPosts = useCallback(() => {
        const contactIds = new Set(loadChatContacts().map(c => c.characterId));
        setPosts(getAllPosts().filter(p => p.authorType === "user" || contactIds.has(p.authorId)));
        setUnreadNotifs(getUnreadMomentsNotifications());
    }, []);

    const captureScrollAnchor = useCallback((): MomentScrollAnchorSnapshot | null => {
        const el = getScrollElement();
        if (!el) return null;
        const containerRect = el.getBoundingClientRect();
        const candidates = Array.from(el.querySelectorAll<HTMLElement>("[data-moment-post-id]"));
        for (const candidate of candidates) {
            const rect = candidate.getBoundingClientRect();
            if (rect.bottom <= containerRect.top) continue;
            if (rect.top >= containerRect.bottom) continue;
            const postId = candidate.dataset.momentPostId;
            if (!postId) continue;
            return {
                postId,
                offsetDelta: candidate.offsetTop - el.scrollTop,
            };
        }
        return null;
    }, [getScrollElement]);

    const restoreScrollAnchor = useCallback((anchor: MomentScrollAnchorSnapshot | null): boolean => {
        const el = getScrollElement();
        if (!el || !anchor) return false;
        const target = Array.from(el.querySelectorAll<HTMLElement>("[data-moment-post-id]"))
            .find(candidate => candidate.dataset.momentPostId === anchor.postId);
        if (!target) return false;
        el.scrollTop = target.offsetTop - anchor.offsetDelta;
        return true;
    }, [getScrollElement]);

    const watchLoadMoreAnchorImages = useCallback((anchor: MomentScrollAnchorSnapshot | null) => {
        const el = getScrollElement();
        if (!el || !anchor) {
            stopLoadMoreAnchorTracking();
            return;
        }
        const target = Array.from(el.querySelectorAll<HTMLElement>("[data-moment-post-id]"))
            .find(candidate => candidate.dataset.momentPostId === anchor.postId);
        if (!target) {
            stopLoadMoreAnchorTracking();
            return;
        }

        loadMoreResizeObserverRef.current?.disconnect();
        loadMoreResizeObserverRef.current = null;
        if (loadMoreAnchorTimerRef.current !== null) {
            window.clearTimeout(loadMoreAnchorTimerRef.current);
            loadMoreAnchorTimerRef.current = null;
        }

        const targetTop = target.getBoundingClientRect().top;
        const imagesAboveAnchor = Array.from(el.querySelectorAll("img"))
            .filter(img => img.getBoundingClientRect().top < targetTop);

        if (imagesAboveAnchor.length === 0) {
            stopLoadMoreAnchorTracking();
            return;
        }

        const restoreAfterImageResize = () => {
            if (loadMoreAnchorRef.current !== anchor) return;
            restoreScrollAnchor(anchor);
            requestAnimationFrame(() => restoreScrollAnchor(anchor));
        };

        if (typeof ResizeObserver !== "undefined") {
            const observer = new ResizeObserver(restoreAfterImageResize);
            imagesAboveAnchor.forEach(img => observer.observe(img));
            loadMoreResizeObserverRef.current = observer;
        }

        imagesAboveAnchor.forEach(img => {
            img.addEventListener("load", restoreAfterImageResize, { once: true });
            img.addEventListener("error", restoreAfterImageResize, { once: true });
            img.decode?.().then(restoreAfterImageResize).catch(() => {});
        });

        loadMoreAnchorTimerRef.current = window.setTimeout(() => {
            if (loadMoreAnchorRef.current === anchor) {
                stopLoadMoreAnchorTracking();
            }
        }, 3000);
    }, [getScrollElement, restoreScrollAnchor, stopLoadMoreAnchorTracking]);

    const visiblePosts = posts.slice(0, visiblePostCount);
    const hasMorePosts = visiblePostCount < posts.length;

    const handleLoadMorePosts = useCallback(() => {
        if (!hasMorePosts) return;
        stopLoadMoreAnchorTracking();
        const el = getScrollElement();
        if (el) {
            loadMoreAnchorRef.current = captureScrollAnchor();
            loadMoreRestoreRef.current = {
                scrollHeight: el.scrollHeight,
                scrollTop: el.scrollTop,
            };
        }
        setVisiblePostCount(current => Math.min(current + MOMENTS_LOAD_MORE_COUNT, posts.length));
    }, [captureScrollAnchor, getScrollElement, hasMorePosts, posts.length, stopLoadMoreAnchorTracking]);

    const closeComposer = useCallback(() => {
        setActiveComposer(null);
        setComposerText("");
        composerInputRef.current?.blur();
    }, []);

    const openCommentComposer = useCallback((post: MomentPost) => {
        setComposerText("");
        setActiveComposer({ postId: post.id });
    }, []);

    const openReplyComposer = useCallback((post: MomentPost, comment: MomentComment, replyName: string) => {
        setComposerText("");
        setActiveComposer({
            postId: post.id,
            replyTo: {
                commentId: comment.id,
                authorId: comment.authorId,
                authorType: comment.authorType,
                name: replyName,
            },
        });
    }, []);

    const submitComposer = useCallback(() => {
        const text = composerText.trim();
        const target = activeComposer;
        if (!text || !target) return;

        addMomentComment({
            postId: target.postId,
            authorType: "user",
            authorId: "user",
            content: text,
            replyToCommentId: target.replyTo?.commentId,
            replyToAuthorId: target.replyTo?.authorId,
            replyToAuthorType: target.replyTo?.authorType,
        });

        closeComposer();
        refreshPosts();
        window.dispatchEvent(new CustomEvent("moments-updated"));
        onUserComment(target.postId);
    }, [activeComposer, closeComposer, composerText, refreshPosts]);

    useEffect(() => {
        if (!activeComposer) return;
        const timer = window.setTimeout(() => {
            composerInputRef.current?.focus({ preventScroll: true });
        }, 40);
        return () => window.clearTimeout(timer);
    }, [activeComposer]);

    useEffect(() => {
        if (!activeComposer) return;
        const exists = posts.some(post => post.id === activeComposer.postId);
        if (!exists) closeComposer();
    }, [activeComposer, closeComposer, posts]);

    useLayoutEffect(() => {
        const restore = loadMoreRestoreRef.current;
        if (!restore) return;
        const el = getScrollElement();
        const anchor = loadMoreAnchorRef.current;
        if (el && !restoreScrollAnchor(anchor)) {
            el.scrollTop = restore.scrollTop;
        }
        loadMoreRestoreRef.current = null;
        watchLoadMoreAnchorImages(anchor);
    }, [getScrollElement, restoreScrollAnchor, visiblePostCount, watchLoadMoreAnchorImages]);

    useEffect(() => {
        const bodyEl = getScrollElement();
        if (!bodyEl) return;
        
        const handleScroll = () => {
            setHeaderScrolled(bodyEl.scrollTop > 160);
        };
        bodyEl.addEventListener('scroll', handleScroll, { passive: true });
        return () => bodyEl.removeEventListener('scroll', handleScroll);
    }, [getScrollElement]);

    useEffect(() => {
        refreshPosts();

        const handler = () => refreshPosts();
        window.addEventListener("moments-updated", handler);

        const savedId = kvGet(COVER_ASSET_KEY);
        if (savedId) {
            getChatImageFromIndexedDB(savedId).then(url => {
                if (url) setCoverUrl(url);
            });
        }

        return () => {
            window.removeEventListener("moments-updated", handler);
        };
    }, [refreshPosts]);

    useEffect(() => {
        window.dispatchEvent(new CustomEvent("chat-hide-tabbar", { detail: showCompose }));
        return () => {
            window.dispatchEvent(new CustomEvent("chat-hide-tabbar", { detail: false }));
        };
    }, [showCompose]);

    const handleDeleteConfirm = () => {
        if (confirmDeleteId) {
            deleteMomentPost(confirmDeleteId);
            setConfirmDeleteId(null);
            refreshPosts();
            window.dispatchEvent(new CustomEvent("moments-updated"));
        }
    };

    const handlePublished = () => {
        setShowCompose(false);
        refreshPosts();
        window.dispatchEvent(new CustomEvent("moments-updated"));
    };

    const handleCoverUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const img = new Image();
        const objectUrl = URL.createObjectURL(file);
        img.onload = () => {
            const maxSize = 800;
            let w = img.width, h = img.height;
            if (w > maxSize || h > maxSize) {
                if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
                else { w = Math.round(w * maxSize / h); h = maxSize; }
            }
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d")!;
            ctx.drawImage(img, 0, 0, w, h);
            canvas.toBlob(blob => {
                URL.revokeObjectURL(objectUrl);
                if (!blob) return;
                saveChatImageToIndexedDB(blob).then(assetId => {
                    kvSet(COVER_ASSET_KEY, assetId);
                    getChatImageFromIndexedDB(assetId).then(url => {
                        if (url) setCoverUrl(url);
                    });
                });
            }, "image/jpeg", 0.8);
        };
        img.src = objectUrl;
        e.target.value = "";
    };

    return (
        <>
        <PageShell
            title="朋友圈"
            onBack={onCloseApp}
            rightAction={
                <button
                    onClick={() => setShowCompose(true)}
                    className="page-back-btn text-[#000]"
                    title="发布朋友圈"
                    type="button"
                    aria-label="发布朋友圈"
                >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M4 6h3.2l1.4-2h6.8l1.4 2H20c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V8c0-1.1.9-2 2-2zm8 11c2.76 0 5-2.24 5-5s-2.24-5-5-5-5 2.24-5 5 2.24 5 5 5zm0-2c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3z"/>
                    </svg>
                </button>
            }
            className={`moments-feed-page ${headerScrolled ? "is-scrolled" : ""} ${activeComposer ? "has-comment-modal" : ""}`}
            bodyRef={scrollRef}
            footer={showCompose ? (
                <MomentsCompose
                    onClose={() => setShowCompose(false)}
                    onPublished={handlePublished}
                />
            ) : activeComposer ? (
                <div className="feed-comment-modal-layer" data-ui="modal">
                    <button
                        type="button"
                        className="feed-comment-modal-backdrop"
                        aria-label="关闭评论输入"
                        onClick={closeComposer}
                    />
                    <div
                        className="feed-comment-modal-dialog"
                        data-ui="modal-dialog"
                        role="dialog"
                        aria-modal="true"
                        aria-label={activeComposer.replyTo ? `回复 ${activeComposer.replyTo.name}` : "发表评论"}
                    >
                        <div className="feed-comment-modal-title">
                            {activeComposer.replyTo ? `回复 ${activeComposer.replyTo.name}` : "发表评论"}
                        </div>
                        <textarea
                            ref={composerInputRef}
                            value={composerText}
                            onChange={e => setComposerText(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                                    e.preventDefault();
                                    submitComposer();
                                } else if (e.key === "Escape") {
                                    closeComposer();
                                }
                            }}
                            placeholder={activeComposer.replyTo ? `回复 ${activeComposer.replyTo.name}` : "说点什么吧"}
                            className="feed-comment-modal-input"
                        />
                        <div className="feed-comment-modal-actions">
                            <button
                                type="button"
                                className="feed-comment-modal-cancel"
                                onClick={closeComposer}
                            >
                                取消
                            </button>
                            <button
                                type="button"
                                className="feed-comment-modal-send"
                                disabled={!composerText.trim()}
                                onClick={submitComposer}
                            >
                                发送
                            </button>
                        </div>
                    </div>
                </div>
            ) : undefined}
        >
                {/* 微信风格 Cover + Avatar Area */}
                <div className="relative w-full bg-white mb-8">
                    
                    {/* Background Cover - 固定高度比例 */}
                    <div
                        onClick={() => coverInputRef.current?.click()}
                        className="w-full aspect-[4/3] bg-[#f0f0f0] cursor-pointer overflow-hidden"
                    >
                        {coverUrl && (
                            <img
                                src={coverUrl}
                                alt=""
                                className="w-full h-full object-cover"
                            />
                        )}
                    </div>
                    <input
                        ref={coverInputRef}
                        type="file"
                        accept="image/*"
                        onChange={handleCoverUpload}
                        className="hidden"
                    />

                    {/* 头像和名字浮层 - 绝对定位骑在底部边界上 */}
                    <div className="absolute right-4 bottom-[-24px] flex items-center justify-end gap-4 pointer-events-none z-10">
                        {/* 名字 (带白色文字阴影以防背景太白看不清) */}
                        <span className="text-[19px] font-bold text-white tracking-wide" style={{ textShadow: "0 1px 4px rgba(0,0,0,0.4)" }}>
                            {userIdentity?.name ?? "我"}
                        </span>
                        
                        {/* 微信方圆头像 */}
                        <div className="w-[72px] h-[72px] rounded-[8px] bg-[#f0f0f0] overflow-hidden flex items-center justify-center pointer-events-auto shrink-0 shadow-sm">
                            {userIdentity?.avatarUrl ? (
                                <img src={userIdentity.avatarUrl} alt="" className="w-full h-full object-cover" />
                            ) : (
                                <span className="ts-24 text-[var(--c-icon)] font-bold">{(userIdentity?.name ?? "我")[0]}</span>
                            )}
                        </div>
                    </div>
                </div>
                
                {/* 个性签名 - 靠右 */}
                <div className="flex justify-end pr-4 mb-6">
                    <div className="text-[13px] text-[#888] max-w-[70%] text-right">
                        {editingSignature ? (
                            <input
                                ref={sigInputRef}
                                defaultValue={signature}
                                autoFocus
                                className="bg-transparent outline-none text-right w-full border-b border-[#07C160] pb-1 text-[#333]"
                                onBlur={(e) => handleSignatureSubmit(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") handleSignatureSubmit((e.target as HTMLInputElement).value); }}
                            />
                        ) : (
                            <span className="cursor-pointer break-words" onClick={() => setEditingSignature(true)}>
                                {signature || "点击设置签名"}
                            </span>
                        )}
                    </div>
                </div>

                {/* Unread notifications banner */}
                {unreadNotifs.length > 0 && (
                    <div className="flex justify-center mb-4">
                        <button
                            className="bg-[#333] text-white rounded-[4px] px-3 py-2 text-[14px] flex items-center gap-2 shadow-md"
                            onClick={() => setShowNotifModal(true)}
                        >
                            <span>{unreadNotifs.length} 条新消息</span>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m9 18 6-6-6-6"/></svg>
                        </button>
                    </div>
                )}

                {/* Posts list */}
                {posts.length === 0 ? (
                    <div className="py-10 text-center text-[#999] text-[14px]">
                        还没有动态，发一条吧
                    </div>
                ) : (
                    visiblePosts.map(post => (
                        <MomentPostCard
                            key={post.id}
                            post={post}
                            onUpdate={refreshPosts}
                            onRequestDelete={setConfirmDeleteId}
                            onOpenCommentComposer={openCommentComposer}
                            onOpenReplyComposer={openReplyComposer}
                        />
                    ))
                )}
                {hasMorePosts && (
                    <div className="flex justify-center px-4 pt-3 pb-8">
                        <button
                            type="button"
                            className="text-[#576B95] text-[14px] px-4 py-2"
                            onClick={handleLoadMorePosts}
                        >
                            查看更多动态
                        </button>
                    </div>
                )}

            {/* Delete confirm dialog */}
            {confirmDeleteId && (
                <ConfirmDialog
                    title="确定删除这条朋友圈吗？"
                    message="删除后无法恢复，评论也会一并删除。"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="删除"
                    cancelLabel="取消"
                    onConfirm={handleDeleteConfirm}
                    onCancel={() => setConfirmDeleteId(null)}
                />
            )}

            {/* Notification detail modal */}
            {showNotifModal && (
                <div className="modal-overlay" onClick={() => { setShowNotifModal(false); saveMomentsLastSeen(); setUnreadNotifs([]); }}>
                    <div className="modal-dialog" onClick={e => e.stopPropagation()} style={{ maxHeight: "60vh", overflow: "auto" }}>
                        <div className="ts-16 font-semibold text-center text-[var(--c-text)] mb-3">新消息</div>
                        {unreadNotifs.length === 0 ? (
                            <div className="ts-14 text-[var(--c-icon)] text-center py-4">暂无新消息</div>
                        ) : (
                            <div className="flex flex-col gap-3">
                                {unreadNotifs.map((n, i) => (
                                    <div key={i} className="flex flex-col gap-1 px-1">
                                        <span className="ts-13 text-[var(--c-text)]">
                                            <span className="font-semibold">{n.authorName}</span>
                                            {n.type === "comment" ? " 评论了你：" : n.type === "reply" ? " 回复了你：" : " 赞了你的朋友圈"}
                                        </span>
                                        {n.content && <span className="ts-13 text-[var(--c-icon)] leading-relaxed">{n.content.slice(0, 100)}{n.content.length > 100 ? "..." : ""}</span>}
                                    </div>
                                ))}
                            </div>
                        )}
                        <button
                            className="ui-btn ui-btn-ghost ui-btn-bordered-ghost w-full mt-3"
                            onClick={() => { setShowNotifModal(false); saveMomentsLastSeen(); setUnreadNotifs([]); }}
                        >知道了</button>
                    </div>
                </div>
            )}

        </PageShell>
        </>
    );
}

