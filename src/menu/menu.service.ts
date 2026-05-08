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
        address: true,
        phone: true,
        instagram: true,
        whatsapp: true,
        languages: true,
        defaultLanguage: true,
        reservationsEnabled: true,
        ordersEnabled: true,
        orderMode: true,
        x: true,
        y: true,
        company: {
          select: { id: true, plan: true, subscriptionStatus: true, trialEndsAt: true },
        },
      },
    });
    if (!restaurant) throw new NotFoundException("restaurant not found");

    const [categories, items] = await Promise.all([
      this.prisma.category.findMany({
        where: { companyId: restaurant.company.id, isActive: true },
        orderBy: { sortOrder: "asc" },
        select: { id: true, name: true, translations: true, sortOrder: true },
      }),
      this.prisma.item.findMany({
        where: { companyId: restaurant.company.id, isActive: true },
        orderBy: { sortOrder: "asc" },
        select: {
          id: true,
          categoryId: true,
          name: true,
          description: true,
          price: true,
          imageUrl: true,
          allergens: true,
          translations: true,
          sortOrder: true,
        },
      }),
    ]);

    return {
      restaurant,
      categories,
      items: items.map((i) => ({ ...i, price: Number(i.price) })),
    };
  }
}
