import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class MenuService {
  constructor(private readonly prisma: PrismaService) {}

  async getBySlug(slug: string) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { slug },
      select: {
        id: true,
        title: true,
        description: true,
        slug: true,
        accentColor: true,
        currency: true,
        source: true,
        hideTitle: true,
        menuLayout: true,
        titleScale: true,
        languageSwitcher: true,
        address: true,
        phone: true,
        instagram: true,
        whatsapp: true,
        languages: true,
        defaultLanguage: true,
        reservationsEnabled: true,
        reservationMode: true,
        reservationSlotMinutes: true,
        reservationSchedule: true,
        ordersEnabled: true,
        orderMode: true,
        orderNameEnabled: true,
        orderPhoneEnabled: true,
        orderAddressEnabled: true,
        x: true,
        y: true,
        googlePlaceId: true,
        // Per-restaurant billing — trial / plan come straight off the
        // restaurant now (no Company hop).
        plan: true,
        subscriptionStatus: true,
        trialEndsAt: true,
      },
    });
    if (!restaurant) throw new NotFoundException("restaurant not found");

    const [categories, items, tables] = await Promise.all([
      this.prisma.category.findMany({
        where: { restaurantId: restaurant.id, isActive: true, deletedAt: null },
        orderBy: { sortOrder: "asc" },
        select: { id: true, name: true, translations: true, sortOrder: true, isGroup: true, parentId: true },
      }),
      this.prisma.item.findMany({
        // Only items in a live (non-deleted) category reach diners. Covers both
        // soft-deleted categories and any orphaned items.
        where: { restaurantId: restaurant.id, isActive: true, deletedAt: null, category: { deletedAt: null } },
        orderBy: { sortOrder: "asc" },
        select: {
          id: true,
          categoryId: true,
          name: true,
          description: true,
          price: true,
          imageUrl: true,
          allergens: true,
          diets: true,
          translations: true,
          sortOrder: true,
        },
      }),
      this.prisma.table.findMany({
        where: { restaurantId: restaurant.id, isActive: true, deletedAt: null },
        orderBy: { number: "asc" },
        select: { id: true, number: true, capacity: true, zone: true, translations: true, imageUrl: true },
      }),
    ]);

    return {
      restaurant,
      categories,
      items: items.map((i) => ({ ...i, price: Number(i.price) })),
      tables,
    };
  }
}
